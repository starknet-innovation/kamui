# Plan: Kamui, the SNF embedded wallet, built from scratch on permissive components

Status: draft for hand-off, 2026-11-11. Written for an agent or engineer picking this up with no prior context. Spike results are in [SPIKES.md](SPIKES.md) and are folded in below.

## 1. Goal

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
| Browser prover | `starknet-innovation/snip-36-prover-wasm` (vendored in social-account `client/public/prover/`) | Apache-2.0 | Experimental, desktop Chromium only, no mainnet mode. Keep its `LICENSE` and `THIRD_PARTY_NOTICES.md` with the vendored files. |
| Backend prover | Docker SNIP-36 prover used by social-account's backend | Not checked | Measured once: 36.6 s per `prove_jwt` proof on an M3 Max, more than 8 GB of memory with the current image |

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

**D2. Pepper.** Decided 2026-11-12: an SNF pepper service, required before any mainnet account. With `pepper = 0`, anyone who knows a user's `sub` can compute their address, and the pepper cannot be changed after deployment. Recommended: do not create mainnet accounts until the pepper service exists. The service must return the same pepper regardless of `aud`, and losing its key makes accounts unrecoverable, so it needs a key-management and backup design of its own.

**D3. `aud` strategy.** Decided 2026-11-12: one SNF-owned OAuth client per issuer, used only by the keychain domain, with a second SNF client as the only override-recovery entry. The address includes `aud`. Recommended: one SNF-owned OAuth client per issuer, used only by the keychain domain, so a user has the same account in every app. Define the override-recovery whitelist and who governs it.

**D4. Owner model across devices.** Decided 2026-11-12: option (b), a new device adds a key. Stock OZ has one public key, and `recover` replaces it, so a login on a second device invalidates the first. Options:
- (a) Keep single owner; each new device re-proves. Simple, stays close to audited OZ code, poor multi-device experience.
- (b) Owner set: `recover` adds a device key (bounded count), with remove and rotate. Better experience, replaces part of OZ's `AccountComponent`, larger audit.
Recommended: (b), pending a real measurement. One measured run put a backend recovery at about 47 seconds from proof request to usable account on a high-end machine, above the threshold where (a) stops being acceptable. Repeat the measurement (three runs, mid-range hardware) before writing the owner code.

**D5. What happens to sessions on recovery.** Decided 2026-11-12: every change of the owner set revokes all sessions. That covers a login on a new device, a finalized override, and a key added or removed by an owner. The cost is accepted: signing in on a second device ends the sessions on the first, which must be approved again. A recovery may mean the old key was compromised. Recommended: a per-account session epoch (SNIP-41 open issue 3), bumped on every `recover` and `set_public_key`, so all sessions die in one write.

**D6. Session limit mechanism.** Recommended: nonce anchoring on the self-paid path and a bounded SNIP-9 nonce range on the sponsored path, to meet the write budget. Fall back to a counter if the nonce design slips.

**D7. Session scope.** SNIP-41 whitelists selectors, not `(contract, selector)` pairs, and has no calldata restriction. A session allowed `transfer` can call it on any contract. Decide whether to (i) accept this and require a Part H spending policy for every session, or (ii) add contract-scoped whitelists as an extension and propose it for the SNIP. Recommended: (ii), since the keychain's approval screen needs to show users which contracts a session can touch.

**D8. Registry governance.** Whoever can write to `JwkRegistry` can take over every account. Decide the multisig, timelock, and monitoring for key rotation, and whether the registry address stays a compile-time constant. social-account has no watcher on `KeySet` events yet; a process independent of the rotator must compare each written key against the issuer's JWKS and alert on a mismatch.

**D9. Where proofs are made.** Browser proving needs desktop Chromium with wasm memory64 and either about 14 GB or about 3 GB of wasm memory, and takes a few minutes. Recommended: backend proving by default in v1, browser proving as an opt-in on capable desktops. With backend proving the JWT is sent to SNF's prover: it cannot redirect the recovery (the nonce binds the new key) but it learns the user's identity.

## 5. Spikes

Status after the first pass (details in [SPIKES.md](SPIKES.md)): S3 and S4 are closed. S2 is partly closed. S1 is still open.

- **S1. Proof time. Partly closed.** One run each on an M3 Max: backend 36.6 s proof and about 47 s to a usable account; browser memory build 183 s proof and 197 s total. The current backend prover image needs more than 8 GB. Repeats and mid-range hardware are still to do. A real run needs a Google OAuth client, two funded Sepolia accounts, an RPC that serves storage proofs, Docker with 8 GB, and scarb 2.20.1 / snforge 0.64.0. Measure end-to-end login and recovery time, in-browser and with the backend prover, on mid-range hardware. A comment in `component.cairo` sizes the proof window for about 4 minutes of in-browser proving. This number decides D4 and the whole onboarding flow, because a new account has key `0` and needs a proof before its first transaction.
- **S2. SNIP-36 availability. Partly closed.** Mainnet runs Starknet 0.14.4, which includes proof verification, and a third-party prover reports mainnet end-to-end tests (its own claim). Still to do: find an official statement, and run `prove_jwt` + `recover` on mainnet. The prover must be upgraded in the same window as each network upgrade.
- **S3. OZ SRC9 fit. Closed: not usable as-is.** OZ's component validates through `is_valid_signature`, writes the nonce before the signature check, and has no hook. Kamui writes its own `execute_from_outside_v2` and reuses OZ's `ISRC9_V2` interface, `snip12_utils` hashing and `execute_calls`.
- **S4. Licences. Closed.** See section 3. The paymaster is GPL-3.0.

## 6. Work plan

### Phase 1: contracts

Status 2026-11-12: in `contracts/` (see its README). Done: `SocialComponent`, `JwkRegistry` and `ProverExecutor` from upstream (one file adapted), `SessionKeyComponent` from the spec, Kamui's own `execute_from_outside_v2`, the admin blocklist, and the owner set (D4). No upgrade path, by decision (D1). 134 snforge tests pass, including upstream's run against the Kamui account. A devnet run confirms at most one storage write per session transaction. The class was run end to end on Sepolia with real proofs on 2026-11-12 (two logins, an owner-approved session, sponsored and self-paid session transactions; `spikes/s1/results/RESULTS.md`, run 3). The spending policy (SNIP-41 Part H, as written) was added afterwards; 158 tests pass, and the final class was run on Sepolia the same day, including owner changes and spending limits (run 4). Not done: pepper service (D2) and the class freeze that D1 requires before mainnet.

1. Fork social-account's `social_account` package into the `kamui` repo. Keep `SocialComponent`, `JwkRegistry` and `ProverExecutor`.
2. Write `SessionKeyComponent` to SNIP-41 as revised in PR 180, from the spec. Include the fee cap, epoch (D5), limit mechanism (D6) and scope decision (D7).
3. Write the account contract: OZ account + SRC5 + social + sessions + Kamui's own `execute_from_outside_v2` (S3: owner path as in OZ; session path checks whitelist, then signature, then records, with the SNIP-9 nonce write as the single session write) + upgrade path (D1) + owner model (D4). Re-derive `PROOF_VALIDITY_BLOCKS` for mainnet block times; the current 1000 was sized for Sepolia.
4. Admin blocklist must cover at least: `upgrade`, `set_public_key` / `setPublicKey`, `recover`, `finalize_override_recovery`, `cancel_override_recovery`, `prove_jwt`, `add_or_update_session_key`, `revoke_session_key`, spending-policy setters, `__execute__`, `execute_from_outside_v2`, and any owner-set functions.
5. Optional: Part H `SpendingPolicyComponent`. Required if D7 goes with option (i).
6. Tests: every SNIP-41 validation step and its ordering, `max_calls = 1`, fee-cap overflow, session after recovery, session trying each blocklisted selector, replay across accounts and chains, override-recovery delay and cancel, upgrade path, address derivation fixed across implementation upgrades.

Done when: all tests pass on a devnet, a gas profile shows at most one storage write per session transaction, and the address-derivation scheme is frozen and documented.

### Phase 2: backend

1. Harden social-account's recover API, prover service, relayer and JWK rotator for production (rate limits, monitoring, key handling). The committed `backend/.env` and `client/.env` were checked and hold only addresses, class hashes and an API URL. Add the `KeySet` watcher (D8). Budget for a flat 75M L2 gas per proof on every deployment and recovery the relayer pays for.
2. Pepper service (D2).
3. Paymaster (AVNU's, run unmodified as a separate service because it is GPL-3.0) with per-app sponsorship budgets and abuse controls. The relayer that pays for deployment and recovery uses the same budget controls.
4. Session and app registry: which app requested which session, for display and revocation.
5. Indexer for balances and activity (use an existing provider if one fits).
6. Optional: username → address registry.

### Phase 3: SDK and connector

1. TypeScript SDK on starknet.js: account interface, session creation and signing, `OutsideExecution` construction, iframe messaging. Start from social-account's `client/src/sdk`.
2. Wallet-standard connector so apps integrate the same way they do other Starknet wallets.
3. Session-only provider for server and native contexts.

### Phase 4: keychain

1. Thin iframe app on a domain that will never change (OAuth redirect URIs and stored keys are bound to it).
2. Flows: login (Google, Apple), first-time proof with progress, session approval showing contracts, selectors, expiry, fee cap and spending limits, per-transaction approval, session list and revoke, recovery and override recovery with cancel, device list if D4 is (b).
3. Key storage: device key encrypted at rest in the iframe origin; never exposed to the embedding app.
4. Strict CSP, pinned dependencies, reviewed release process.

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
- With backend proving (D9), SNF's prover sees each login JWT and so learns who the user is.
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
