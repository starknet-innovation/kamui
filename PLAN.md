# Plan: Kamui, the SNF embedded wallet, built from scratch on permissive components

Status: draft for hand-off, 2026-11-11. Written for an agent or engineer picking this up with no prior context. Spike results are in [SPIKES.md](SPIKES.md) and are folded in below.

## 1. Goal

Current rollout scope, 2026-11-12: Google only. Existing Apple support is retained, with Apple setup and live testing deferred.

Ship Kamui, a Controller-style embedded wallet for Starknet: social login, session keys, sponsored transactions, one iframe keychain shared by all apps. Built without any Cartridge code.

**Out of scope for v1:** gaming features (achievements, marketplace, starter packs), fiat purchases, EVM-wallet owners, native mobile SDK.

## 2. Hard constraint: no Cartridge code

`cartridge-gg/controller` and `cartridge-gg/controller-rs` share a custom licence: all rights reserved, with a non-commercial grant (capped at 10,000 MAU, restriction passes to derivatives, Cartridge decides what qualifies). Treat both repos as off limits:

- Do not copy, port or paraphrase their code, and do not use them as a reference while implementing.
- Implement from public standards only: SNIP-5, SNIP-6, SNIP-9, SNIP-12, SNIP-41.
- This reading of the licence needs legal review before SNF relies on it.

## 3. Building blocks

| Block | Source | Licence | State |
|---|---|---|---|
| Account base | OpenZeppelin Cairo contracts (`openzeppelin_account` 4.0.1, as pinned by social-account) | MIT (confirmed at tag v4.0.1) | Production |
| Social login | `keep-starknet-strange/social-account` | MIT | Proof of concept, one external review, Sepolia only |
| Sessions | SNIP-41, as revised in `starknet-io/SNIPs` PR 180 | Spec | Open PR, draft |
| Session reference code | `chipi-pay/sessions-smart-contract` | MIT | Implements the previous revision of SNIP-41, not PR 180 |
| Paymaster | `avnu-labs/paymaster` (named in SNIP-41) | **GPL-3.0** | Run as a separate service behind its API. Do not copy its code into contracts, SDK or keychain. Needs legal review. |
| Browser prover | `starknet-innovation/snip-36-prover-wasm`, v1.0.1 baseline pinned in `keychain/CLIENT_PROVING.md` | Apache-2.0 | Integrated into current keychain; actual Kamui V2 recovery remains unverified. Desktop Chromium memory64, actual Kamui V2 proof unverified. Keep `LICENSE` and `THIRD_PARTY_NOTICES.md` with distributed assets. |
| Backend prover (historical; excluded from target D9) | Docker SNIP-36 prover used by social-account's backend | Not checked | Measured once: 36.6 s per `prove_jwt` proof on an M3 Max, more than 8 GB of memory with the current image |

### What social-account gives you (verified from the repo)

- `SocialAccount` = stock OZ `AccountComponent` + `SRC5Component` + `SocialComponent`. Constructor is `(aud, identity)`; the public key is `0` until the first recovery.
- `ISocialRecoverable`: `prove_jwt`, `recover`, `identity`, `finalize_override_recovery`, `cancel_override_recovery`.
- `prove_jwt` runs only inside the SNIP-36 prover (virtual block). It verifies RS256 against `JwkRegistry` (garaga), checks `exp`, `nonce = h(new_pubkey, blinding)`, `iat > last_recovery`, and the identity. On chain, only `recover` runs and it checks proof facts.
- Address = `udc_address(class, salt = identity, from_zero, [aud, identity])`, with `identity = h(iss, aud, sub, pepper)`.
- Override recovery (a different whitelisted `aud`) has a 7-day delay and a 7-day finalize window.
- `JWK_REGISTRY_ADDRESS` is a hard-coded constant in the component.
- Backend services: recover API, prover, relayer, JWK rotator. Client: SDK plus demo app with the in-browser prover.
- Issuers: Google and Apple.
- About 2,500 lines of Cairo. `SECURITY.md` says: not audited for production, do not hold real funds, deployed accounts cannot be upgraded.

### What SNIP-41 (PR 180) requires

- `ISessionKeyManager`: `add_or_update_session_key(session_key, valid_until, max_calls, max_fee_per_tx, allowed_entrypoints)`, `revoke_session_key`, `get_session_data`.
- Session signature: `[session_pubkey, r, s, valid_until]`. Lengths other than 2 or 4 are rejected.
- Validation order: expiry → session exists → transaction limit → fee cap → admin blocklist → selector whitelist → ECDSA → record the transaction (always after signature verification).
- Fee cap: computed from V3 resource bounds in `u256`, must not panic; `max_fee_per_tx == 0` means paymaster-only.
- Storage budget: at most one write per session transaction after setup. Options named in the spec: counter, nonce anchoring (self-paid), bounded SNIP-9 nonce range (sponsored).
- Admin selector blocklist that sessions cannot bypass; `__execute__` blocked for sessions.
- SNIP-9 v2 `execute_from_outside_v2` with session signature passthrough; whitelist checked before signature, recording after.
- SRC-5 interface ID `0x9da822b09dda470480ed02c12ae8745d4ac010023df23c6db0314abe5cdc02`.
- Optional Part H: per-token spending policy.
- `is_valid_signature` is read-only and cannot enforce whitelists.
- Component pattern: `SessionKeyComponent` embedded through a `HasAccountOwner` trait.

## 4. Decisions to make before writing contract code

These are ordered by how expensive they are to change later. D1 to D3 fix the account address, so they cannot change after the first mainnet account.

**D1. Upgradeability and address stability.** Decided 2026-11-12: no upgrades for now. Accounts are not upgradeable and the address commits to the class hash. Consequences: the class must be final before the first mainnet account; any later change means new addresses and a migration of funds by each user; the SDK must keep the list of class hashes it has ever deployed. The recommendation below was not taken. The address commits to the class hash. Every contract change after launch would otherwise produce new addresses for the same user, and social-account accounts are not upgradeable today. Recommended: deploy all accounts from a small frozen bootstrap class that immediately `replace_class`es to the current implementation, and add owner-gated upgrades with a timelock. Decide who can change the "current implementation" pointer; that party is a trust root.

**D2. Pepper.** Decided 2026-11-12: an SNF pepper service, required before any mainnet account. A design note and a reference implementation are in `services/pepper/` (2026-11-12). Decided the same day: the key is generated by AWS KMS and never leaves it, with no backup outside AWS, users can export their pepper as a recovery file, and the key proof is required on every request. The KMS-backed key holder is written, tested against a fake KMS client, and was run against a real multi-Region test key in a dedicated test account. Beyond that, the design has open questions for the project owner and needs legal and privacy review before it is relied on. With `pepper = 0`, anyone who knows a user's `sub` can compute their address, and the pepper cannot be changed after deployment. Recommended: do not create mainnet accounts until the pepper service exists. The service must return the same pepper regardless of `aud`, and losing its key makes accounts unrecoverable, so it needs a key-management and backup design of its own.

**D3. `aud` strategy.** Decided 2026-11-12: one SNF-owned OAuth client per issuer, used only by the keychain domain, with a second SNF client as the only override-recovery entry. The address includes `aud`. Recommended: one SNF-owned OAuth client per issuer, used only by the keychain domain, so a user has the same account in every app. Define the override-recovery whitelist and who governs it.

**D4. Owner model across devices.** Decided 2026-11-12: option (b), a new device adds a key. Stock OZ has one public key, and `recover` replaces it, so a login on a second device invalidates the first. Options:
- (a) Keep single owner; each new device re-proves. Simple, stays close to audited OZ code, poor multi-device experience.
- (b) Owner set: `recover` adds a device key (bounded count), with remove and rotate. Better experience, replaces part of OZ's `AccountComponent`, larger audit.
Recommended: (b), pending a real measurement. One measured run put a backend recovery at about 47 seconds from proof request to usable account on a high-end machine, above the threshold where (a) stops being acceptable. Repeat the measurement (three runs, mid-range hardware) before writing the owner code.

**D5. What happens to sessions on recovery.** Decided 2026-11-12: every change of the owner set revokes all sessions. That covers a login on a new device, a finalized override, and a key added or removed by an owner. The cost is accepted: signing in on a second device ends the sessions on the first, which must be approved again. A recovery may mean the old key was compromised. Recommended: a per-account session epoch (SNIP-41 open issue 3), bumped on every `recover` and `set_public_key`, so all sessions die in one write.

**D6. Session limit mechanism.** Recommended: nonce anchoring on the self-paid path and a bounded SNIP-9 nonce range on the sponsored path, to meet the write budget. Fall back to a counter if the nonce design slips.

**D7. Session scope.** SNIP-41 whitelists selectors, not `(contract, selector)` pairs, and has no calldata restriction. A session allowed `transfer` can call it on any contract. Decide whether to (i) accept this and require a Part H spending policy for every session, or (ii) add contract-scoped whitelists as an extension and propose it for the SNIP. Recommended: (ii), since the keychain's approval screen needs to show users which contracts a session can touch.

**D8. Registry governance.** Whoever can write to `JwkRegistry` can take over every account. Decide the multisig, timelock, and monitoring for key rotation, and whether the registry address stays a compile-time constant. social-account has no watcher on `KeySet` events yet; a process independent of the rotator must compare each written key against the issuer's JWKS and alert on a mismatch.

**D9. Where proofs are made.** Updated by the user on 2026-11-12: prove client-side in the keychain using `starknet-innovation/snip-36-prover-wasm`, with no automatic server-proving fallback. The inspected v1.0.1 release uses the low-memory V2 circuit (`PROOF2`); the old browser spike used `PROOF1`; the relay now accepts the pinned V2 profile. Browser integration, authenticated first deployment and durable proof submission are now prepared in the repository. Actual Kamui V2 JWT recovery passed on the existing Sepolia account in bundled Chromium 153 (run 11); runs 1–10 used backend proving. First deployment/recovery-file faults with V2 and broader browser/resource acceptance remain pending. The proposed AWS stack has no hosted prover or prover-account credential. See `keychain/CLIENT_PROVING.md` for the pinned baseline, integration sequence and privacy boundaries. This supersedes the earlier backend-default recommendation.

## 5. Spikes

Status after the first pass (details in [SPIKES.md](SPIKES.md)): S3 and S4 are closed. S2 is partly closed. S1 is still open.

- **S1. Proof time. Partly closed.** One run each on an M3 Max: backend 36.6 s proof and about 47 s to a usable account; browser memory build 183 s proof and 197 s total. The current backend prover image needs more than 8 GB. Repeats and mid-range hardware are still to do. A real run needs a Google OAuth client, two funded Sepolia accounts, an RPC that serves storage proofs, Docker with 8 GB, and scarb 2.20.1 / snforge 0.64.0. Measure end-to-end login and recovery time, in-browser and with the backend prover, on mid-range hardware. A comment in `component.cairo` sizes the proof window for about 4 minutes of in-browser proving. This number decides D4 and the whole onboarding flow, because a new account has key `0` and needs a proof before its first transaction.
- **S2. SNIP-36 availability. Partly closed.** Mainnet runs Starknet 0.14.4, which includes proof verification, and a third-party prover reports mainnet end-to-end tests (its own claim). Still to do: find an official statement, and run `prove_jwt` + `recover` on mainnet. The prover must be upgraded in the same window as each network upgrade.
- **S3. OZ SRC9 fit. Closed: not usable as-is.** OZ's component validates through `is_valid_signature`, writes the nonce before the signature check, and has no hook. Kamui writes its own `execute_from_outside_v2` and reuses OZ's `ISRC9_V2` interface, `snip12_utils` hashing and `execute_calls`.
- **S4. Licences. Closed.** See section 3. The paymaster is GPL-3.0.

## 6. Work plan

### Phase 1: contracts

Status 2026-11-12: in `contracts/` (see its README). Done: `SocialComponent`, `JwkRegistry` and `ProverExecutor` from upstream (one file adapted), `SessionKeyComponent` from the spec, Kamui's own `execute_from_outside_v2`, the admin blocklist, and the owner set (D4). No upgrade path, by decision (D1). 134 snforge tests pass, including upstream's run against the Kamui account. A devnet run confirms at most one storage write per session transaction. The class was run end to end on Sepolia with real proofs on 2026-11-12 (two logins, an owner-approved session, sponsored and self-paid session transactions; `spikes/s1/results/RESULTS.md`, run 3). The spending policy (SNIP-41 Part H, as written) was added afterwards; 158 tests pass, and the final class was run on Sepolia the same day, including owner changes and spending limits (run 4). A first security audit then filed five findings (issues 1 to 5 on the repository). The two in the contracts are fixed: `recover` refuses proofs made before the registry's latest revocation, and replacing a key counts as a revocation; 168 tests. Those fixes change the registry's interface, so the account needs a Kamui-deployed registry and a new declaration before the next live run. Not done: pepper service (D2) and the class freeze that D1 requires before mainnet.

1. Fork social-account's `social_account` package into the `kamui` repo. Keep `SocialComponent`, `JwkRegistry` and `ProverExecutor`.
2. Write `SessionKeyComponent` to SNIP-41 as revised in PR 180, from the spec. Include the fee cap, epoch (D5), limit mechanism (D6) and scope decision (D7).
3. Write the account contract: OZ account + SRC5 + social + sessions + Kamui's own `execute_from_outside_v2` (S3: owner path as in OZ; session path checks whitelist, then signature, then records, with the SNIP-9 nonce write as the single session write) + upgrade path (D1) + owner model (D4). Re-derive `PROOF_VALIDITY_BLOCKS` for mainnet block times; the current 1000 was sized for Sepolia.
4. Admin blocklist must cover at least: `upgrade`, `set_public_key` / `setPublicKey`, `recover`, `finalize_override_recovery`, `cancel_override_recovery`, `prove_jwt`, `add_or_update_session_key`, `revoke_session_key`, spending-policy setters, `__execute__`, `execute_from_outside_v2`, and any owner-set functions.
5. Optional: Part H `SpendingPolicyComponent`. Required if D7 goes with option (i).
6. Tests: every SNIP-41 validation step and its ordering, `max_calls = 1`, fee-cap overflow, session after recovery, session trying each blocklisted selector, replay across accounts and chains, override-recovery delay and cancel, upgrade path, address derivation fixed across implementation upgrades.

Done when: all tests pass on a devnet, a gas profile shows at most one storage write per session transaction, and the address-derivation scheme is frozen and documented.

### Phase 2: backend

Status 2026-11-12: upstream's backend is now in `services/backend/` with the Kamui changes as code (owner anchor, Kamui class, prover memory) and the pepper confirmed with the pepper service before anything is paid for; 17 tests. The pepper service is in `services/pepper/` and runs against AWS KMS. It ran live on Sepolia in run 5. A development `/sponsor` endpoint stands in for the paymaster. Not done: hardening (step 1), the `KeySet` watcher, the paymaster (step 3), the session and app registry (step 4) and the indexer (step 5).

Status 2026-11-12, later: a first internal audit filed five issues (starknet-innovation/kamui 1 to 5); each has a fix and regression tests. On the backend: the rotator compares key material, not only key ids, and the issuer key cache refetches on an unknown key id; `/sponsor` reserves budget before it sends and has per-app budgets and a fee ceiling per transaction; rate limits, structured logs without identities, metrics, and a `KeySet` watcher (step 1). The session and app registry (step 4) is in, with owner-signed requests that cover the record and are accepted once. The pepper is confirmed with the pepper service only before a deployment, so a sign-in from a recovery file works when that service is lost. 118 tests, all with fakes. Terraform templates for the two test AWS accounts are in `infra/aws/terraform/`; they have not been applied and need review by whoever owns SNF's AWS setup. Not done: AVNU's paymaster (step 3; `/sponsor` is still the stand-in), the indexer (step 5), more than one api process, keys from a secret store in the running service. This round ran on Sepolia on 2026-11-12 (`spikes/s1/results/RESULTS.md`, run 8), with a Kamui key registry and a new class.

Status 2026-11-12, recovery jobs: `POST /recover` now returns a job ID (202) after authenticating the request. The SDK polls `POST /recover/status` until success or failure; disconnected submissions retry with the same ID. Jobs are bounded and held in the api process, with terminal results retained for 30 minutes. An api restart loses them; no durable queue or automatic resubmission on a missing job. Tested locally; not yet run on Sepolia.

1. Harden social-account's recover API, prover service, relayer and JWK rotator for production (rate limits, monitoring, key handling). The committed `backend/.env` and `client/.env` were checked and hold only addresses, class hashes and an API URL. Add the `KeySet` watcher (D8). Budget for a flat 75M L2 gas per proof on every deployment and recovery the relayer pays for.
2. Pepper service (D2).
3. Paymaster (AVNU's, run unmodified as a separate service because it is GPL-3.0) with per-app sponsorship budgets and abuse controls. The relayer that pays for deployment and recovery uses the same budget controls.
4. Session and app registry: which app requested which session, for display and revocation.
5. Indexer for balances and activity (use an existing provider if one fits).
6. Optional: username → address registry.

Status 2026-11-12, paymaster integration: an opt-in SNIP-29 transport routes `/sponsor` to an unmodified AVNU service, preserving the signed SNIP-9 payload and Kamui's app budgets. A separate compose overlay and operator runbook are in `services/backend/`. Disabled by default and restricted to Sepolia: the local fee estimate is only a preflight ceiling with an external relayer, so real external spending controls need operator/security review. Fakes and compose validation passed; no AVNU service was started and no live compatibility run was done. The exact upstream image's licence needs legal review (README and LICENSE disagree).

Status 2026-11-12, live run 9: job recovery survived a dropped accepted submission response (same job on retry, one proof, one recovery); the managed AVNU service accepted owner session approval and four-element session pings. Scope and replay refusals passed, as did a budget refusal after a dropped successful gateway response. AVNU time bounds needed hex-string serialization, with message hashes unchanged. Receipts and limits are in `spikes/s1/results/RESULTS.md` and `run-9-recovery-jobs-avnu.json`. Restart-safe jobs and external fee controls remain open.

Status 2026-11-12, durable recovery: SQLite now persists terminal results, hashed job capabilities, account locks and pre-broadcast transaction hash/sender/nonce intents. Restart reconciliation requires accepted receipts; interrupted proving needs a fresh sign-in because JWT/pepper/proof are not stored. Unknown intents stay locked; operator resolution requires a finalized replacement and a stopped API. A shared relayer mutex covers local API sends. This remains a single-writer design; budgets/rate limits are still in memory. The runbook is `services/backend/RECOVERY-JOBS.md`. Crash, hash, privacy and acceptance/revert tests cover these boundaries; a synthetic process-exit check reconciled an existing live Sepolia receipt without sending another transaction.

### Phase 3: SDK and connector

Status 2026-11-12: started in `sdk/` (see its README). Done: address derivation, account reader, owner management, sessions with scopes and spending limits, sponsored calls, and a session account for self-paid transactions, and a pepper recovery file (export and import), with 19 unit tests, 7 devnet tests and a live check on Sepolia. The SDK refuses sessions with unlimited token access by default and always estimates session fees with validation on. The login flow was added the same day: nonce and blinding, the redirect answer, the pepper lookup with its key proof (checked against the real pepper service in process), and `recover` through the backend, skipped when the device already owns the account; 19 more tests. A login ran end to end on Sepolia the same day through `apps/login-demo`, with the pepper service on AWS KMS and the backend from the repo (`spikes/s1/results/RESULTS.md`, run 5). Not done: the wallet-standard connector (step 2). The app-side helpers for the keychain's redirect protocol are in `sdk/src/keychain.ts`.

1. TypeScript SDK on starknet.js: account interface, session creation and signing, `OutsideExecution` construction, iframe messaging. Start from social-account's `client/src/sdk`.
2. Wallet-standard connector so apps integrate the same way they do other Starknet wallets.
3. Session-only provider for server and native contexts.

### Phase 4: keychain

Status 2026-11-12: a first version is in `keychain/`, with `apps/demo-dapp` connecting through it and the protocol in `sdk/src/keychain.ts`. It uses full-page redirects, not an iframe: browsers isolate storage in third-party iframes, so a shared iframe keychain needs extra browser permissions. Done: sign-in, session approval with scope, limits and warnings, the device list with removal, the recovery file, encrypted key storage and a strict content security policy. It ran on Sepolia (`spikes/s1/results/RESULTS.md`, run 6). Per-transaction approval was added the same day (run 7). The approval screens show token names and exact amounts, and tell known, unverified and unidentified tokens apart. Its pages and key storage have 34 browser tests in Chrome against network-level fakes. Not done: the session list, embedded modes, a production build and domain, and browsers other than Chrome.

Status 2026-11-12, later: the account page lists the account's sessions and revokes one or all of them. What it shows is read from the account; the registry only supplies which session keys to look up and the site's name. Sign-in from a recovery file (no pepper service call) and an Apple button (shown when an Apple client id is configured) were added. 63 browser tests pass in each of Chrome, Firefox and WebKit, against fakes. Not done: any run against Apple, Safari itself (it deletes script-written storage after seven days without a visit, which would lose the device key), mobile browsers, private windows. The session list, revocation, token display and a recovery-file sign-in ran on Sepolia (run 8).

1. Thin iframe app on a domain that will never change (OAuth redirect URIs and stored keys are bound to it).
2. Flows: login (Google, Apple), first-time proof with progress, session approval showing contracts, selectors, expiry, fee cap and spending limits, per-transaction approval, session list and revoke, recovery and override recovery with cancel, device list if D4 is (b).
3. Key storage: device key encrypted at rest in the iframe origin; never exposed to the embedding app.
4. Strict CSP, pinned dependencies, reviewed release process.

Status 2026-11-12, parallel follow-up: run 10 passed revoke-all, stale-device removal and Google recovery-file sign-in with pepper continuously stopped through confirmation; it was restored afterward. Native Safari 27.2 vault mechanics passed on a benign loopback fixture and modeled total storage loss passed across Chrome/Firefox/WebKit. The naturally elapsed seven-Safari-use-day purge is still pending on a reviewed HTTPS origin, not demonstrated by the fixture. Sign-in/home now explain local key loss and keeping the pepper file outside the browser. `kamui.page` is registered with Cloudflare DNS; `sepolia.kamui.page` is only a proposed Sepolia origin. Configurable HTTPS callback plumbing is prepared, but hosting remains on the AWS-owner review path and no DNS/cloud change was made (`keychain/PUBLIC_ORIGIN.md`). Apple work is deferred by the user.

Status 2026-11-12, AWS hosting review prepared: `infra/aws/terraform/HOSTING_REVIEW.md` and `HOSTING_ACCEPTANCE.md` define the proposed Google-only Sepolia topology, missing implementation, public-origin/Google configuration, storage and signer gates, cost quantities, rollout/rollback and operator acceptance. Revised after the user selected client-side proving: the proposed stack excludes the hosted prover, and adds Wasm assets, browser capability, V2 compatibility and authenticated deployment gates. SQLite/EFS durability remains a review decision. The implementation now prepares browser Workers, authenticated deployment and durable proof relay; Terraform removes the hosted prover and credential. Live Kamui V2 proof validation remains pending. No AWS account APIs, cloud resources, DNS/OAuth settings or service state were changed. The templates remain unapplied and the proposal is unapproved.

Status 2026-11-12, client proving implemented locally: the keychain uses pinned `snip-36-prover-wasm` v1.0.1 Workers with memory-only witnesses, cancellation and capability checks; the API authenticates first deployment and journals completed proofs through polled `/relay`. The public server-proving path is disabled, and the hosted prover/credential are removed from Terraform. 109 SDK and 158 backend tests pass. A real public balance capture generated a V2 proof in bundled Chromium in about 71 s; this is not a Kamui JWT proof or a live recovery. Installed-Chrome native crashes remain unresolved on this machine. See `keychain/CLIENT_PROVING_VALIDATION.md` for test runs and remaining gates.

Status 2026-11-12, run 11: live Google new-device recovery passed with browser-generated V2 proof in headed bundled Chromium 153.0.8010.12, without a new account class. Proof 231,792 bytes, 117.34 s, 3.57 GB Wasm linear memory; accepted recovery at block 18,036,204, owners 3 → 4, previous keys retained, epoch 6 → 7. Reload succeeded without another proof. First deployment and recovery-file/restart faults with client proving remain pending. Native Chromium 158 authentication crashed; a restored-tab attempt/key mismatch was rejected before proving. Details: `spikes/s1/results/run-11-client-proving.md`.

Status 2026-11-12, retention decision: the user selected seven days for hosted backups and operational logs, subject to SNF privacy review. This does not authorize pruning unresolved recovery intents or durable funding history, and no schedule/retention setting was enabled. The separate registry controller refers to Starknet AccessControl permissions, not AWS IAM; its independent account address remains pending.

Status 2026-11-12, wallet/manual-administration/live PostgreSQL follow-up: owner-authorized `/wallet/sponsor` now funds only validated account-self session/device management, with separate default-off durable wallet limits and account/nonce replay debits. Approved-app Ping server now supplies its configured app ID as well as its private server credential; no browser bearer is embedded. Version-3 PostgreSQL migration preserves debit/pause history. Read-only Google freshness watching catches new published keys missing from registry even without events. User selected $100/month planning budget, will act as AWS operator/security reviewer, and selected a separate off-server registry administrator with manual updates. Hosted rotator/admin-key mounts are removed; a mandatory read-only startup gate refuses the API relayer while it retains admin/revoker authority. Unsigned handoff/JWK planners and sanitized AWS preflight are prepared, but no role handoff, AWS administrative/resource change or hosted deployment was done.

Live run 12 passed four Sepolia transactions (wallet approval, credentialed app Ping, client-side Google recovery, wallet revoke-all), actual fees 2.116362690347488448 test STRK within the user-approved four/12-total/max5 limits. Pause survived database/API restarts; a tightened cap refused a fresh valid Ping without debit. API was stopped after an independently accepted recovery receipt while the journal row was still unfinished, then reconciled the same hash after restart. Four existing owners were retained and a fifth added; recovery ended the old session and final revoke-all advanced the epoch to nine. Funding is paused; PostgreSQL history and both profiles retained. The original SQLite files/configuration were untouched. See `spikes/s1/results/run-12-postgres-regression.md`. Hosted policy/retention, operator's independent controller address/handoff and private AWS preflight/acceptance remain pending.

Status 2026-11-12, lean follow-up implementation: PostgreSQL now has durable global/operation/app/account count and FRI limits, conservative pre-send debit accounting, persistent pause and separate deployment/recovery policies. Approved apps require a private server credential; new funding is paused/zero by default. pgBackRest backup/WAL configuration and host restore fencing are implemented; a disposable local production-wrapper restore recovered later replay rows, funding debits/pause and uncertain intents while admission stayed blocked. A two-server Compose/systemd/operator package now builds the production keychain, scopes mounted secrets, provides direct HTTPS, stop-before-start writer checks, reboot fencing and monitoring. No AWS/S3/TLS issuance/KMS permission/alert delivery or actual host boot was tested. Hosted cutover, policy/retention/custody review and keychain wallet-management sponsorship remain pending. Recommend a 4 GiB backend until the smaller host's memory is validated; the earlier $75 target is not validated for this package. Nothing deployed or automatically enabled.

Status 2026-11-12, PostgreSQL migration implementation: backend now has async-compatible PostgreSQL registry and recovery stores, versioned schema, durable awaited intent commits, and an exclusive single-connection API/operator writer lease. The explicit offline cutover imports both SQLite stores read-only, preserves replay hashes/order/network binding/unresolved intents, verifies rows transactionally, and refuses populated/repeated targets. Disposable local PostgreSQL tests cover concurrency, interruption/reconciliation and loss of the database writer connection. No existing user/developer data was migrated. SQLite local compatibility remains; durable sponsorship/funding counters, backup/WAL/restore implementation, EC2 packaging, hosted acceptance and AWS/security review remain pending. Do not treat the database lease as distributed signer fencing; stop the old API before starting another.

Status 2026-11-12, lean hosting decision: after reviewing the managed-stack estimate, the user chose **two EC2 servers with PostgreSQL on the backend server**, keeping pepper in its existing separate AWS test account and its HMAC key in KMS. This supersedes the earlier Fargate/RDS/ALB/WAF target for the initial beta. Open Google-only Sepolia access, selected test subdomains, Ireland estimate, DNS-only Cloudflare and approved-app sponsorship with explicit limits remain. The model is about $56/month; a $75 planning target is proposed, not approved. Replacement edge controls, PostgreSQL migration, durable budgets, off-host backups, stale-restore reconciliation and reviewer/operator ownership are pending. Existing code/templates remain SQLite/Fargate/EFS; no deployment or AWS security changes are authorized. See `infra/aws/terraform/HOSTING_REVIEW.md` and `COST_ESTIMATE.md`.

Status 2026-11-12, hosting decisions: the user selected an **open Sepolia beta** at `sepolia.kamui.page` and `pepper-sepolia.kamui.page`, and **RDS PostgreSQL migration before hosting**. This supersedes the invited-tester/SQLite-on-EFS proposal. The user requested an itemized estimate before setting a budget ceiling; reviewer names were not provided. Region, edge controls, sponsorship policy, availability, key governance and technical deployment review remain open. Current code/templates still use SQLite/EFS until migration; no AWS changes or deployment were authorized by this record.

Status 2026-11-12, hosting decisions continued: the user selected the existing two AWS test accounts, ECS/Fargate and eu-west-1 for the estimate; AWS WAF at both public load balancers with Cloudflare DNS-only and a private API; and approved-app-only sponsorship with anonymous sponsorship off and per-account/per-app/overall spending limits. Exact thresholds, restart-safe funding counters, external AVNU controls, signer setup, reviewer names and budget ceiling remain open. Public rate scenarios and assumptions are in `infra/aws/terraform/COST_ESTIMATE.md`. No account access or cloud change was performed.

### Phase 5: audit and launch

1. Audit 1: contracts, with focus on JWT parsing, RSA verification (`jwt/rsa.cairo` is a custom re-implementation, written because the SNIP-36 prover refuses the builtins garaga's circuit needs), proof-facts checking and session validation.
2. Audit 2: keychain, SDK messaging and backend.
3. Registry governance live (D8), rotator monitored, runbook for issuer key rotation and for revoking a compromised key.
4. Sepolia beta with two or three partner apps, then mainnet with deposit limits, then general availability.

## 7. Trust assumptions to state publicly

- The keychain front end chooses the key bound into the JWT nonce, so whoever serves the keychain (SNF) could take over an account at login. This is the same position as any web wallet, but it means "non-custodial" needs careful wording and legal review.
- `JwkRegistry` writers, the pepper service, and the upgrade authority (D1) are each a trust root.
- The OAuth client owner can recover accounts under its `aud` with no delay (stated in social-account's `SECURITY.md`).
- Google and Apple can recover any account tied to their users.
- Target D9: proofs are computed in the browser. The pepper service still sees the JWT during ordinary lookup, and first-deployment authentication may send it to the API. The prepared keychain runs proofs locally; prior live runs used backend proving and sent the JWT to the backend. Existing-account Google V2 recovery passed in run 11; other browser and deployment/recovery-file flows remain pending. Do not claim the JWT never leaves the browser (`keychain/CLIENT_PROVING.md`).
- A session is only limited on tokens it was given a spending policy for. Under SNIP-41 Part H, kept as written (decided 2026-11-12), a token with no policy is unrestricted, so the keychain must set a policy for every token a session may call and must show the limits on the approval screen.
- A live session key can sign off-chain messages as the account. `is_valid_signature` accepts session signatures, as SNIP-41 requires, and no whitelist or limit applies there (decided 2026-11-11: keep per spec). The keychain's session approval screen must say so, and apps should not treat `is_valid_signature` as proof of owner consent.

## 8. Not verified

- Real proof times (S1), and `prove_jwt` + `recover` on mainnet (S2).
- The licence of the Docker backend prover.
- The GPL-3.0 reading for the paymaster (legal review).
- The Cairo logic of social-account beyond the account contract, the component interface and the first half of `component.cairo`.
- PR 180 is an open draft and may change before merge; pin the commit you implement against (head was `ae0970c` on 2026-11-11).

## 9. Sources

- https://github.com/keep-starknet-strange/social-account
- https://github.com/starknet-io/SNIPs/pull/180
- https://github.com/chipi-pay/sessions-smart-contract
- https://github.com/avnu-labs/paymaster
- https://github.com/starknet-innovation/snip-36-prover-wasm

### 2026-11-12 — KMS secp256k1 registry administrator

User selected AWS KMS custody and then a k1 signer instead of P-256. Added a separate immutable `KmsK1Admin` account and an operator-only starknet.js signer in `infra/aws/registry-admin/`, using KMS `ECC_SECG_P256K1` / `ECDSA_SHA_256` / `DIGEST` on the raw 32-byte Starknet transaction hash. Canonical four-limb low-s signatures; pinned immutable KMS reference/public key, Sepolia/account/class deployment checks, complete resource-bound fee cap and explicit per-signature review callback. No social recovery or hosted administrator credentials. Existing Kamui user-account class hash remains `0x1e128dae2cb709cac9263afa1c6fdb33f7f1f5c2d969547d9739326d08399f6`. Full contract suite: 179 passed (11 new); signer suite: 17 passed; TypeScript check passed. Shared synthetic DER vector validates across TypeScript/Cairo; no real KMS call, AWS change, deployment, role handoff or paid transaction performed. Contract/custody and independent recovery review plus live KMS/Sepolia acceptance remain pending. See [operator design](infra/aws/registry-admin/README.md).

### 2026-11-12 — KMS operator, bounded live preparation and handoff gates

Implemented in parallel: a manual operator check/sign CLI with exact-hash confirmation and accepted-block chain/class/full-key/nonce preflight, repeated after confirmation; private AWS metadata conversion and a one-signature interoperability probe; a durable fixed-run reservation journal; and a separate deployment/Ping-only submitter binding the signed artifact, hash, canonical k1 signature and exact maximum fee to that journal before one paid RPC. Receipt reconciliation uses the canonical block number and never retries a send or refunds a reserved maximum. Independent source review caught and fixed unbounded RPC response reads, dropped deploy-absence error codes, and receipt canonicality checks.

Handoff preparation now pins the new administrator class and full k1 key, and requires a canonical accepted successful V3 invoke from that account before old-role renunciation/final verification. Hosted review records explicitly include off-server KMS permissions and independent recovery; the legacy OFFLINE startup flag only checks relayer contract roles. Prepared operator key-creation commands and a review-only key resource-policy template; IAM static analysis detected only GetPublicKey/Sign in the signer runtime. No policy upload/application occurred.

User confirmed the dedicated k1 key is not created yet and approved a fresh live-test envelope: at most four paid attempts, twelve test STRK aggregate, five maximum fee per attempt, no automatic retries. The journal conservatively includes necessary funding principal plus all fee maxima and retains every attempt across restart, success, revert and uncertainty. External declaration/funding must use that same journal; a new/copied directory is not a new allowance. The test envelope does not include extra registry handoff/hosting fees.

Validation: 84 combined KMS/operator/live-preparation/submission tests, 16 Python readiness/handoff tests, 3 unsigned-JWK planner tests, package and readiness TypeScript checks, documentation links and diff checks passed. No actual AWS request, key creation, KMS signing, paid transaction, account deployment, registry handoff, hosting deployment, commit or push was performed. Live testing awaits the operator-created key; custody/recovery review and actual live evidence still precede role transfer.

### 2026-11-12 — Executable dedicated-key setup

Added `infra/aws/registry-admin/setup-k1-key.sh` and a dependency-free Python wizard. The operator selects three existing same-account role profiles; role references are resolved and retained privately. The wizard prepares the existing resource-policy template, confirms its fingerprint, rechecks creator identity after approval, persists an exclusive creation intent before one KMS CreateKey call with retries/lockout bypass disabled, then saves validated public metadata using the signing profile. Normal reruns resume export without creating another key; ambiguous attempts refuse re-creation and preserve diagnostics. No account/IAM-role creation or contract action. Fifteen mocked Python tests plus shell/help/diff checks passed; no actual AWS calls or settings changes performed. Existing roles, profile sessions and custody/policy review remain operator prerequisites.

### 2026-11-12 — Ordered role/profile/key bootstrap

Added operator-run `00-setup-registry-k1.sh` and numbered `01` role, `02` local-profile, `03` key scripts. One existing operator administrator profile is selected once; new role trust is pinned to that stable same-account IAM user/role principal. All three roles share that bootstrap trust, so independent recovery is explicitly not achieved by this setup. Admin identity permissions are limited to constrained Ireland k1 key creation and exact three-role inspection; signing/recovery use the future key's resource policy. No existing identity policy, service role or account is changed by the setup. Local profile updates preserve existing configuration and keep an exclusive private backup, drift checks and a lock. Tagged role ownership, exact trust/permission readback and persistent mutation intents allow conservative reconciliation without overwriting foreign resources or resending unresolved mutations.

Thirty-two mocked Python tests cover the ordered flow twice, scoped permissions, role/identity drift, ambiguous mutations, profile conflicts and key creation. Shell syntax/help and diff checks pass. No actual AWS account API calls, IAM/key creation, contract actions, commit or push performed. User execution of reviewed scripts remains required.

### 2026-11-12 — Authorized live role/profile/key setup passed

The user explicitly allowed running the new setup scripts, superseding the earlier operator-only AWS-setting restriction for this test. Selected the existing `kamui-backend-test` administrator profile and checked its live identity against the configured test-account role without exposing identifiers. Created and read back the three tagged, purpose-specific operator roles; configured their three local source-profile chains with an exclusive private backup of the prior AWS config; verified all three role assumptions; then created one enabled AWS-generated Single-Region `ECC_SECG_P256K1` / `SIGN_VERIFY` key in Ireland and validated its public key. Independent read-back confirmed the actual KMS key policy equals the reviewed three-role policy. The full numbered sequence rerun passed without another key creation request; one such request is locally recorded. No existing account/user/host trust or policy was broadened by the scripts.

Live integration exposed and fixed CLI stdin JSON parsing, partial CreateRole replies and empty successful PutRolePolicy output. Thirty-four setup tests now pass, including regressions and the complete mocked sequence twice. Sanitized live evidence is in `infra/aws/registry-admin/SETUP_VALIDATION-2026-11-12.json`; real identifiers/config/backups and raw diagnostics remain outside Git under the private setup directory. No KMS Sign call, Starknet administrator deployment, registry role change, hosted deployment or STRK spending occurred. All three IAM roles still share the bootstrap principal, so independent recovery/custody review remains open. No commit or push performed.

### 2026-11-12 — Setup rerun read-timeout handling

The user's completed setup rerun timed out after 45 seconds while reading attached policies on the signing role. Private outputs and saved completion records showed the failure preceded any creation call in that rerun. Fixed misleading generic uncertainty errors: explicitly allowlisted reads have up to three attempts on process/socket timeout, operation-aware redacted status and private call metadata; AWS socket timeouts are now explicitly bounded. Mutations remain single-attempt and retain their persistent intents on uncertainty. The wrapper shows step progress; completed role setup is verification-only and cannot silently repair missing permissions. Five new regressions cover read retry/exhaustion, mutation no-retry, authentication failures and completed-run no-write behavior. Thirty-nine setup tests pass.

Live verification of this fix reran the full numbered sequence successfully. Every operation trace from the verification run was read-only, and the private directory still contains exactly one recorded KMS key-creation request. No roles, policies or keys were recreated.

### 2026-11-12 — Real KMS and Sepolia administrator acceptance

Passed: dedicated KMS k1 interoperability signature, class declaration, 2 test STRK funding, native administrator deployment and harmless Ping. Both native fee estimates used signed query transactions with validation enabled. Four canonical successful receipts, **6.449947451955377354 test STRK** actual fees; Ping 12 → 13, nonce 2, class/full key and balance deltas verified. Read-only original/changing-digest/different-key signature checks passed. User explicitly removed Sepolia STRK caps before any paid send; an uncapped v2 journal preserves exact maximum-fee/hash/nonce reservations and reconciliation, while default v1 caps remain. RPC ABI normalization fixed deployment class-hash preflight; 86 TypeScript and 39 Python tests, typecheck and diff checks pass. [Run 13](spikes/s1/results/run-13-kms-admin.md). No registry roles transferred or hosted deployment; custody/security and independent-recovery review remain pending.

### 2026-11-12 — Parallel handoff, hosting and hosted-beta preparation

Prepared the exact unsigned registry grant and conditional renunciation review after a fresh Sepolia snapshot at block 18,048,447; registry/new-account classes, full public key and canonical run-13 controller proof match. Roles remain with the historical relayer. The user selected sole-KMS administration and explicitly accepted loss-of-key risk; no independent fallback is being prepared. Effective permission/custody and exact authority-change review remain pending.

Added private AWS-selection initialization, regular-file AWS inventory transport and a guarded operator launch wrapper with independent expected-account checks, durable exact ClientToken intent, private outputs and no retry after uncertainty. Added fixed-origin GET-only hosted HTTPS/config/main-bundle/prover-asset acceptance checks and an ordered DNS/Google/browser/funding/restore/alert runbook. Both selected subdomains failed DNS resolution/HTTPS availability checks; no cloud deployment or hosted Google recovery occurred. The existing test account has five devices, requiring an explicit slot-retirement choice or different identity for new-origin recovery. Thirty readiness and twelve host/provision tests pass with fake AWS; no AWS mutation, DNS/OAuth change, role transfer or paid send in this follow-up. See [execution packages](infra/aws/lean/readiness/README.md#current-execution-packages). No approval flags fabricated; AWS provisioning/security changes remain user-run.

Mainnet custody boundary, user clarification: the current sole-KMS/shared-bootstrap setup is accepted for Sepolia only. Mainnet needs a proper separately reviewed KMS custody/permission/recovery setup; no Sepolia risk acceptance carries over. Mainnet authority/funding and recovery/governance remain gated on that design and review.

### 2026-11-12 — Ordered creation of lean AWS prerequisites

Added operator-run `infra/aws/lean/setup/00`–`06` scripts. Prerequisite phases privately pin existing account identities from retained records, reuse the existing pepper HMAC key, freeze the official AL2023 x86 image, create/verify dedicated network and IAM/S3 stacks, then export the strict consumer input. Separate paid phases launch one host per account and assign stable IPs. Exact create intents/tokens, private diagnostics, expected-account checks and read-only reconciliation prevent automatic ambiguous resends; selected existing resources and owned stack outputs are freshly checked, and manual input edits are preserved/refused. No key-policy writer, account creation, registry role transfer, DNS/OAuth write or automatic wallet startup. The existing pepper key policy is checked conservatively and must already permit the new role/delegation; failures stop for review without changing the key. Thirty-two new setup tests plus forty-two existing readiness/host tests and cfn-lint 1.60.1 pass locally; cfn-guard/service/real AWS execution remain unperformed. The sole-KMS arrangement remains Sepolia-only; mainnet custody/recovery is a separate design/review gate.

### 2026-11-13 — Static-IP attachment response correction

The user reported completion of the numbered setup. Local saved launch records exist, but static-IP verification/allocation intents are absent. Cached DescribeInstances responses exposed an incorrect check: embedded InstanceNetworkInterfaceAttachment omits InstanceId. The guard now binds the ENI through the already verified enclosing instance and requires primary device index zero plus attached status. Corrected the fake AWS fixture and added positive real-shape and nonprimary/detached regressions; 34 setup tests pass. Both saved real account responses pass the corrected guard through a read-only replay, not a new AWS request. The operator must rerun 06-addresses.sh with preserved state before DNS; no allocation, association or other AWS operation was run for this fix. Application installation and hosted acceptance remain pending.

### 2026-11-13 — Numbered image release and public host installation

Added operator-run scripts 07–10: additive private ECR/artifact-bucket/pull-policy stacks, committed sanitized linux/amd64 image builds with upstream digest pins and verified Wasm, local-only private runtime/database credential preparation, content-addressed public package delivery through SSM, disabled-unit installation and immutable image retrieval with ephemeral instance-role ECR auth. Runtime files/passwords/signing keys never enter image contexts, public archives, artifact uploads or SSM command bodies. No runtime secret delivery, wallet/PostgreSQL start, database initialization/restore acknowledgement, registry role change, DNS/OAuth action or funding enablement is implemented by these steps. Source must be committed/clean before publication; no commit/push done by implementation.

Durable stack/push/upload/command evidence handles interrupted operations without ambiguous resends. Independent integration review fixed cross-account bucket metadata access, installer source symlink refusal, root ownership/link/mode checks and canonical AL2023 os-release links. A real-shell regression proves a failed download checksum cannot continue into installer execution; script 10 performs fresh read-only verification after each completed check. Compose v2.40.3 binary/checksum is pinned and upstream/project notices retained. Fifty installation plus seventy-six existing resource/readiness/host tests pass (126 total), shell syntax and cfn-lint 1.60.1 pass. No AWS API operation, real image build/push or remote installation was run. Effective permissions, actual SSM/ECR/S3 delivery, scans/licenses, runtime secret delivery, restore/alerts and hosted acceptance remain operator checks; sole-KMS custody acceptance remains Sepolia-only.

### 2026-11-13 — Resume OCI-index publication and private runtime preparation

The operator's first step 07 created the release stacks and pushed the keychain image, then stopped because Docker published an OCI image index (linux/amd64 plus unknown/unknown attestation), not a direct image manifest. The checker now verifies the root/index and unique amd64 child digests before comparing its config to the saved local build; it preserves the root deployment digest and never repushes an existing intent. Narrow clean committed infrastructure-helper descendants may resume the frozen original application release; app/Dockerfile changes and unrelated history remain refused. Original tags, build records, contexts, resource/push intents and source pins are retained, with publisher revision recorded separately.

Step 08's private backend metadata source had mode0644. Tightened that gitignored file to0600, kept the private-source guard and made its diagnostic specific. Local step08 then succeeded, preparing eleven private runtime files with external signer delivery/startup still pending. No key was extracted/uploaded, no AWS request/push/remote command was sent, and no service started for this fix. Fifty-four installation tests cover index/attestation resume without repush, child hash/architecture ambiguity, helper-only source continuation and retained private-source refusal. Real ECR child validation/publication continuation remains for the operator after committing the fix.
