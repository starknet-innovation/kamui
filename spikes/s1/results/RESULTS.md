# S1 results

Machine: Apple M3 Max, 36 GB. Network: Starknet Sepolia. social-account at `e168134`. One run per row so far; the plan is three.

## Run 1: browser prover, memory build, recovery of an already deployed account

2026-11-11, in the Claude desktop app's browser pane (Chromium). Source: the demo page's prover log and the api log.

| Step | Time |
|---|---:|
| RSA hint and prover setup | 1.3 s |
| State acquisition and execution | 36.9 s |
| Virtual OS and PIE | 3.4 s |
| Recursive proving | 141.5 s |
| of which: Cairo proof | 96.1 s |
| of which: circuit verifier proof | 41.5 s |
| Proof ready to recovery confirmed | 14.0 s |
| **Total, click to usable account** | **197 s (3 min 17 s)** |

- Peak wasm memory: 2.92 GB.
- Proof size: 231,873 bytes (limit 480,000), 9 facts.
- Recovery transaction: `0x55075843d3c56ac9acd7454816b22e17e4899b40d43350a75211bb768fb83ed`.
- Account: `0x2bca5e92133bbaa3cbe62421d66f4bdf96b4216036715029f0852bc174b5e19`.

## Run 2: backend (Docker) prover, recovery of an already deployed account

2026-11-11. Prover image `snip-36-prover-backend@sha256:3624a08b…8a4f` (built 2026-11-10, prover 0.20.0-rc.1), 8 CPUs, memory cap raised to 20 GB. Source: prover log and api log.

| Step | Time |
|---|---:|
| State acquisition and virtual OS execution | 16.2 s |
| Recursive proving | 20.4 s |
| of which: Cairo proof | 13.4 s |
| of which: circuit verifier proof | 6.4 s |
| **Proof total (prover's own figure)** | **36.6 s** |
| Proof ready to recovery confirmed | 10.4 s |
| **Total, proof request to usable account** | **47 s** |

- Memory: the container's peak counter read **19.5 GB**, against a 20 GB cap. That counter includes file cache, so the true requirement is somewhere between 8 GB and 19.5 GB. It is certainly above 8 GB: with upstream's 8 GB cap the container was OOM-killed (exit 137) five seconds into the Cairo proof.
- Upstream's "about 30 s, 3 to 4.2 GB" was measured on prover image v1.3.1. It does not hold for the current image.
- Proof size: 230,160 bytes, 9 facts. Transaction size: about 1.18 million Cairo steps.
- Recovery transaction: `0x3eddad283e7b2c9204299b845eddc2ebf1b9e5fd1eae1c62d2ac8d4b81e5433`.
- Not included: the Google sign-in itself and the browser round trips before the proof request.

## Comparison (one run each, same machine)

| | Backend | Browser, memory build |
|---|---:|---:|
| Proof | 36.6 s | 183 s |
| Click to usable account | about 47 s | 197 s |
| Peak memory | 8 to 19.5 GB | 2.9 GB |

## Account deployment (first login only)

About 5 seconds from request to the api's "deployed" log line (one sample, transaction `0x3b9982997a279ee2029162c01b22496f7397ad3a3972305e8b0bb873bccac80`).

## Not yet run

- Browser prover, standard build.
- Backend prover with the older v1.3.1 image, and with fewer CPUs, to find the real memory and cost per proof.
- Repeats, and anything on mid-range hardware.

## Setup notes

- The RPC matters. `starknet-sepolia-rpc.publicnode.com` serves storage proofs only for the newest block and made the first attempt fail. `api.zan.top/public/starknet-sepolia/rpc/v0_10` serves about 100 blocks back and works.
- The api needs a recent bun (1.1.4 fails on `Bun.serve` routes; 1.4.4 works).

## Run 3: the Kamui account on Sepolia, end to end

2026-11-12. Kamui class `0x6b3cd8dd5787fcef206ffd2362970bfac3973930b509d7de6fc1cb61fc07fdc` (commit `f067f32`), declared in `0x2acbc49a8fec6627388b503dccd3d83a560a05bd72b45cb6379206e1fbc9ccb` for 59.45 test STRK. Upstream's registry and prover executor reused. Backend prover, same machine as runs 1 and 2. Upstream's backend and client patched as in `../kamui-owner-set.patch`.

Account: `0x4e8a09edd57bc4c65e7e19858cfb4549ad7f14c3fabf9a96b7ab41adeaa828e`.

| Step | Result |
|---|---|
| First login: deploy, prove, recover | Works. Proof 36.9 s (225,195 bytes, 1.19M steps), about 61 s from request to usable account. One owner, session epoch 1. Recovery tx `0x211e75e626c4fdef085db22812290eba8b084e476e89677b038de913f45a346`. |
| Second login, as a second device | Works. Proof 227,841 bytes. Two owners, oldest first, session epoch 2. Recovery tx `0x499512e9e82d9113c2efdd25c025e6a6b359809f801e002e020c32538ee24fe`. |
| Second device's key approves a contract-scoped session, sponsored | Works (owner-signed outside execution, relayer pays). |
| Session, sponsored: allowed call | Works. |
| Session, sponsored: call outside its scope, nonce outside its range, owner management | Each refused with `Kamui: invalid session`. |
| Session, sponsored: replay of a used nonce | Refused with `Kamui: duplicated nonce`. |
| Session, self-paid: two allowed transactions | Work. The nonce limit was anchored at first use (account nonce + 3). |
| Session, self-paid: call outside its scope, owner management | Each refused at validation. |

What this shows that the tests and devnet did not:

- `prove_jwt` and `recover` work for the Kamui class with a real proof, and the proof is no slower than for upstream's class (36.9 s against 36.6 s).
- A session signature passes `__validate__` on a real sequencer, with its validate-mode restrictions, including the storage write that anchors the nonce limit.
- The outside-execution hash built by starknet.js is accepted on a live network, for owner and session signatures.

Not covered by this run:

- Storage-write counts on Sepolia: the RPC's traces carry no state diff. The devnet figures in `contracts/README.md` stand.
- Removing an owner, a recovery on a full owner set, and override recovery, on a live network.
- A negative check caveat: starknet.js skips `__validate__` when estimating fees unless told otherwise. The first attempt at the self-paid negative checks therefore reported "not refused"; with validation on, they are refused. An SDK must not rely on a default fee estimate to learn whether a session transaction is allowed.

Scripts: `contracts/scripts/declare-sepolia.ts`, `sepolia-check.ts`, `sepolia-session.ts`.

## Run 4: the final class on Sepolia, with owner changes and spending limits

2026-11-12. Class `0x13c5e8166199db99e894da9e55ce642267e5258c42eae8851357747b6201fdc` (commit `ac8e8a8`, with the spending policy), declared in `0x4e9e5fa8a3bbfddcfd5f7dac15b6d08784d30f3072d6ca0564d85435b0767dc` for 64.25 test STRK. Same setup as run 3.

Account: `0x222c6332e5b184b8b0ff1016ca6d7cb54a169221b65700cff35ff637e055b3e`. The address was computed before the login from the identity and the class hash, and matched.

| Step | Result |
|---|---|
| Login: deploy, prove, recover | Works. Proof 33.4 s (231,117 bytes, 1.19M steps), about 58 s from request to usable account. |
| Owner adds a second key (owner-signed outside execution, relayer pays) | Works. Session epoch moves. |
| The second key approves a session scoped to two functions, with a spending policy of 100 per call and 150 per hour | Works. |
| Session, sponsored: allowed call; spend 100 | Work. |
| Session, sponsored: call outside its scope, nonce outside its range, owner management | Each refused with `Kamui: invalid session`. |
| Session, sponsored: replay of a used nonce | Refused with `Kamui: duplicated nonce`. |
| Session, sponsored: spend 101 | Refused with `Spending: over per-call limit`. |
| Session, sponsored: spend 51 after 100 | Refused with `Spending: over window limit`. |
| Session, self-paid: allowed call; spend 50, reaching 150 | Work. The account reports 150 spent in the window. |
| Session, self-paid: spend 1 more | Refused with `Spending: over window limit`. |
| Session, self-paid: call outside its scope, owner management | Each refused at validation. |
| Owner removes the second key | Works. Session epoch moves. |
| The session after the owner change | Refused with `Kamui: invalid session`. |
| The removed key approving a session | Refused with `Kamui: invalid signature`. |

New on a live network compared with run 3: `add_owner`, `remove_owner`, sessions dying on an owner change, and spending limits on both paths sharing one window.

A finding for the SDK, the second of its kind:

- A self-paid session transaction with a spending check ran out of gas on the first attempt (`Insufficient max L2Gas: max amount 1,465,051, actual used 2,072,908`). starknet.js estimates fees without running `__validate__` and without the real signature unless told otherwise. `__execute__` applies spending policies only when it sees a session signature, so the estimate skipped the spending check and came out about 30% low. The fee was charged, the transaction reverted, and the spent amount was not recorded, which is the intended behaviour for a failed transaction.
- With `skipValidate: false` the same transaction went through. The SDK must always estimate session transactions that way.

Not covered: a recovery on a full owner set, override recovery, and storage-write counts (no state diff in this RPC's traces).

Leftover state: the first attempt added a throwaway second key before failing, and the script only removes the key it added on the rerun. The test account therefore still has two owners, the device key and that throwaway key, whose private key was never stored.

## Run 5: login through the whole chain, with a pepper

2026-11-12. Everything from the repo, running locally against Sepolia: the SDK's login flow in a browser (`apps/login-demo`), the pepper service on a test AWS KMS key, the backend in `services/backend`, the prover, and the class from run 4. Same machine.

Account: `0x3ec3b3ead6762ecf0172e0d5e3f9df472e66608e3f483f300a784dc9652d193`. It is a new account with a new identity: the pepper is part of the address, so it differs from the account in runs 3 and 4 for the same Google user.

| Step | Result |
|---|---|
| First login | Works, 60.2 s from the token arriving to a usable account. Pepper service with key proof 0.2 s; backend's own confirmation of the pepper 38 ms; deployment, proof (35.0 s) and recovery 59.6 s. One owner, session epoch 1. Recovery tx `0x4449ee434c57b45337ffba998b63b06f466a770d77912b35eec81622c7c2211`. |
| Sign in again from the same device | Nothing was sent: the pepper service saw one request and the backend none, and the account did not change. The page's own result was replaced by the next step before it was read, so this is from the service logs and the chain. |
| Sign in as a new device | Works, 44.6 s (no deployment). Two owners, session epoch 2. Recovery tx `0x59db6a90bd794648b8f48e9c08ea1a57bffdba60e443e2b8a1314cab0e6e1ea`. |

First time on a live network for: the SDK's login flow, the key proof, a pepper derived by AWS KMS, the backend confirming the pepper before paying, a proof with a non-zero pepper, and a returning device skipping the proof.

Pepper service timings, from its log: 106 to 212 ms for a request from the browser (the first includes fetching Google's keys), 37 to 38 ms for the backend's confirmation.

Not covered: the pepper recovery file used for a login, override recovery, Apple, and a refused wrong pepper on a live run (covered in tests only).

## Run 6: an app connecting through the keychain

2026-11-12. The keychain (`keychain/`), the demo app (`apps/demo-dapp`), the backend with its `/sponsor` endpoint, the pepper service on the test KMS key and the prover, all local, on Sepolia. Same account as run 5.

| Step | Result |
|---|---|
| The demo app sends the user to the keychain | The keychain shows the app's origin and asks for a sign-in. |
| Sign-in in the keychain, as a new device | Works: a key for the keychain's device is added with a proof. |
| The keychain shows the request and the user approves | Works: the session is registered by an owner-signed call that the relayer pays for (`0x3f43869cbbb857c9c16d76f59d14e6ec751d73cc202c96dece2b82f24115d37`), and the user returns to the app. |
| The app pings with its session key, sponsored | Works: confirmed in 7.4 s, and the contract's count went from 6 to 7 (`0x7d3432e1befdc6651fc5726efebd77a460ab7ce87e94b1f048a670dd798bec1`). |
| The app tries a function the session was not given | Refused by the account: `Kamui: invalid session`. Nothing was sent. |
| The keychain's home page | Lists the account's four device keys and marks its own. |

One thing the run exposed, now fixed: the sign-in happened twice, so two keys were added for the same device and the first is unused. The likely cause is that a keychain page drawn before the first sign-in still offered "Continue with Google" afterwards. The keychain now looks at its stored login again before starting a sign-in. The account has four owners as a result; the unused key can be removed from the home page.

Not exercised: removing a device, the recovery file download, "forget this device", a refused request (covered by tests), and any browser other than the one in the Claude desktop app.

## Run 7: one transaction approved in the keychain

2026-11-12. The keychain, the demo app and the backend's `/sponsor`, local, on Sepolia. Same account as runs 5 and 6. No sign-in was needed: the keychain still had its device key.

| Step | Result |
|---|---|
| The demo app connects | Works without a sign-in; the session is registered (`0x4a8ecbeb5da707d2193b7e208a6c258c29a283fb06bac1139e83a99d60ac22d`). |
| The app asks for a call outside its session | The keychain shows the site, the call and that it uses the account's full authority. |
| The user approves | The call is sent as an owner-signed outside execution paid by the relayer (`0x567f7a3819b98865f4faa2db39032d2ee2cd7c322676cdbff31c4485a0c5f03`), and the user returns to the app with the hash. The contract's count went from 7 to 8. |
| The session afterwards | Still live: an owner transaction that does not change the owners leaves sessions alone. |

Not exercised live: a denied transaction, and a request for a call to the account itself (both covered by the browser tests).

## Run 8: the audited class, the session registry and a recovery-file sign-in

2026-11-12. Everything from the round after the first internal audit, local, on Sepolia: the pepper service (AWS KMS), the backend with its hardening and the session registry, the prover in Docker, the keychain and the demo app. A new key registry and a new account class, so a new account.

Set-up:

- Key registry deployed from this repository (it has `last_revocation_block`, audit issues 1 and 5): `0x4bc2b2afcce053e788511a851e6aeb004d18adb243df4fe852e1b727bd09808`, block 18030487, owned by the relayer account. The rotator set Google's 2 and Apple's 3 keys.
- Account class with that registry pinned: `0x1e128dae2cb709cac9263afa1c6fdb33f7f1f5c2d969547d9739326d08399f6`, declared for 65.17 STRK.
- Account: `0x133739e82cd76b5a6446848ae0cbbbb8cc4762fbb8e0eb5ebc417209423e0e9`.

| Step | Result | Fee (STRK) |
|---|---|---|
| First login from the demo app | The backend confirmed the pepper with the pepper service, deployed the account (`0x16ded728…1581`) and proved the token in 34 s; `recover` landed (`0x6b70279e…11bd`). | 0.140 + 1.949 |
| Session approval | Sponsored (`0x2a3d70d7…52a0`). The keychain recorded the session in the registry, with the owner's signature over the whole record. | 0.087 |
| Session list | The keychain listed the session from the registry; scope, expiry and limits were read from the account. | |
| Ping through the session | Confirmed in 8.1 s (`0x4c65b18b…21a7`). | 0.053 |
| A call outside the session's scope | Refused at fee estimation (`Kamui: invalid session`); nothing was sent or paid. | |
| Revoke from the keychain | `revoke_session_key`, sponsored (`0x4a898c3a…7717`). The list emptied, and the next ping with that session was refused. | 0.049 |
| A new session, then a one-off approval of 1.5 STRK | Approval sponsored (`0x713ff321…a33`). The keychain named the token (STRK), the spender and the amount (1.5 STRK, and 1500000000000000000 in the smallest unit). Denied, so nothing was sent. | 0.087 |
| Sign-in from a recovery file | File downloaded, device forgotten, file chosen, Google sign-in. The pepper service got no request; the backend skipped its pepper check because the account existed; proof and `recover` (`0x65320671…f9a`). Same address, a second device key, and every session ended (D5). | 1.902 |

The relayer spent 93.0 STRK in all, 65.2 of it on the class declaration.

Found and fixed during the run:

- **Native `confirm()` dialogs.** The keychain's "Forget this device", "Remove" and "Revoke all sessions" did nothing in the app's browser pane, which answers native dialogs with "cancel" without showing them. They now confirm inside the page, and a test fails if the keychain opens a native dialog.
- **Demo app.** Denying a one-off transaction dropped the app's connection although its session was still live.

Seen and not explained: midway through, the keychain page in the pane showed "Sign in" and its storage read empty, while the window the user was looking at was still signed in. The next connection needed no sign-in. Probably a stale tab of the hidden pane; not investigated further.

Not exercised live: Apple, `Revoke all sessions`, removing a device, the registry's replay refusal (covered by the backend's tests), and Safari.

## Run 9: recovery jobs and AVNU sponsorship

2026-11-12. Local services against Sepolia, the account and class from run 8. The managed AVNU endpoint (`https://sepolia.paymaster.avnu.fi`), with the API key configured locally by the user; no self-hosted AVNU container. Public receipts and outcomes: [run-9-recovery-jobs-avnu.json](run-9-recovery-jobs-avnu.json).

| Step | Result | Actual fee (STRK) |
|---|---|---:|
| Google login on a new device, using a recovery job | The API returned 202. A temporary proxy closed the first submission connection after acceptance, without returning its answer. The SDK retried with the same ID; both submissions joined one job. 78 polls ended in success, with one proof and one recovery transaction (`0x2f83dce7…c0cd`). Owners and session epoch both moved from 2 to 3. | 1.902385152325418560 |
| Owner approves the Ping demo's scoped session, through AVNU | Confirmed (`0x6f22bdab…a82a`), session recorded in the registry, app connected. Two-element owner signature accepted. | 0.102469182357952384 |
| Session ping, through AVNU | Confirmed (`0x74b0c4fc…48e5`), counter 9 → 10. Four-element session signature and its reserved nonce accepted. | 0.065220292165457344 |
| Call outside the session scope | `400 REVERTED: Kamui: invalid session` at local fee estimation. Nothing submitted to AVNU. | 0 |
| Replay the confirmed ping's public signed payload | `400 REVERTED: Kamui: duplicated nonce` at local estimation. Nothing submitted to AVNU. | 0 |
| AVNU ping whose successful gateway response is dropped | Confirmed (`0x5f48ed2e…eef6`), counter 10 → 11, although the client received no hash. The hash was recovered from the gateway's transaction log and checked on chain. | 0.065220292165457344 |
| Another ping under a temporary one-transaction budget | `429 ACCOUNT_BUDGET_SPENT`. Losing the previous response did not release its budget. No additional transaction. | 0 |

All four receipts show `SUCCEEDED` and `ACCEPTED_ON_L2` when checked. Each of the three AVNU transactions has a fee-paying sender different from Kamui's relayer. AVNU paid about 0.233 test STRK in total; Kamui's relayer paid for recovery only.

Found and fixed during the run:

- **AVNU time bounds.** starknet.js emits `Execute After` and `Execute Before` as JSON numbers; AVNU's felt decoder expects hexadecimal strings. Initial owner approvals returned `PAYMASTER_SUBMISSION_UNCERTAIN` and no session event appeared. Normalizing those fields to hex strings fixed the live approval without changing its numeric values or SNIP-12 message hash. The existing owner/session hash checks still pass, with a new assertion for the wire representation.
- **Diagnostics.** Rejected paymaster responses now log only their HTTP status and numeric JSON-RPC code, never upstream text or payloads.

The recovery fault proxy dropped the accepted **submission** response, not an in-progress proof. The AVNU fault proxy dropped the successful **gateway-to-client** response, after AVNU had returned a hash; an AVNU-to-gateway timeout before a hash was not injected. The client did not automatically retry that sponsored call. It displayed `no transaction hash in the answer`; callers must reconcile a lost response before sending another transaction.

After the run, the fault proxy was stopped, the temporary one-transaction budget removed, and the normal api, keychain and demo servers restarted. AVNU remains enabled through the user's gitignored local settings. The account has three owner keys and the test session remains live until its displayed expiry; the target counter is 11.

Not established: recovery jobs surviving an API restart (they do not), a first deployment through the job protocol, a proof longer than 255 seconds, production availability, an enforceable external paymaster fee ceiling, or mainnet support. Local preflight bounds do not constrain AVNU's own relayer fees. Exact-version licensing and production spending controls still need the appropriate reviews.

## Run 10: revoke-all, stale-device removal and Google recovery during a pepper outage

2026-11-12. All three requested live checks passed on the account from runs 8 and 9. Full public evidence and receipts are in [run-10-device-session-recovery.md](run-10-device-session-recovery.md) and [run-10-device-session-recovery.json](run-10-device-session-recovery.json).

- Revoke-all through AVNU: confirmed, epoch 3 → 4; the old session's data and public signature became invalid.
- Remove the oldest stale device through AVNU: confirmed, owners 3 → 2 and epoch 4 → 5. Its already-public signature became invalid while the remaining device's signature stayed valid. The current key was preserved.
- Export the private recovery file, forget the local device, stop pepper, and sign in with Google using the file: confirmed on the same account, owners 2 → 3 and epoch 5 → 6. Pepper's socket refused connections before and during proving and after the receipt was accepted. Pepper was then restored healthy.

The final account view showed three devices and no live sessions. The private recovery file is not an evidence artifact. This run used the already-running pre-durable API, so it does not establish restart behavior for the new journal. The current scope is Google only.

Separately, [durable-reconciliation-2026-11-12.json](durable-reconciliation-2026-11-12.json) records an abrupt child-process exit after writing a synthetic intent, followed by SQLite reopening and reconciliation against run 10's existing live recovery receipt. The lock and terminal result persisted; this check sent no new transaction and did not simulate an actual live submission crash.

## Client-side prover integration — offline, 12 November 2026

The keychain now prepares execution and proves locally with pinned snip-36-prover-wasm v1.0.1 Workers, then submits to the durable V2 relay. The server-proving API is disabled in the public entrypoint. This is implementation validation, **not a new live Sepolia run**: no Google Kamui JWT proof or new chain transaction was made.

The real public balance-capture test generated a 231,440-byte V2 proof in 71.01 s, with 3,203,596,288 bytes of Wasm linear memory in bundled Chromium. [Public measurements](client-proving-runtime-2026-11-12.json) and [validation limits](../../../keychain/CLIENT_PROVING_VALIDATION.md) distinguish the real Worker test from mocked UI checks and record installed-Chrome native crashes. Actual Kamui JWT compatibility, memory/time, first deployment and recovery receipts remain to be tested live.

## Run 11: Google recovery with client-side V2 proving

2026-11-12. Passed on the existing Sepolia account in headed bundled Chromium 153.0.8010.12. The browser executed the Google JWT recovery and generated a 231,792-byte V2 proof in 117.34 s (3,574,595,584 bytes Wasm linear memory), then submitted it through the durable relay. No server-proving or deployment route was called, and the relay request contained no JWT or pepper.

Recovery transaction `0x1c0f98c6d9d61d6ffde317cb256ef69a57f22b29cfa459321320dd390abe207` succeeded at block 18,036,204. The new device is an owner; owners 3 → 4, all prior keys retained, epoch 6 → 7, class unchanged. Actual fee: 1.935060442125421920 test STRK. Reload required no new proof/submission and the signed registry-list request succeeded.

[Run details](run-11-client-proving.md) and [public evidence](run-11-client-proving.json) record the browser/profile failures before the successful single-tab retry and the remaining scope. First deployment, recovery-file outage and live restart/lost-response tests with V2 are still pending. No cloud deployment, commit or push was made.

## Run 12: PostgreSQL funding and owner wallet sponsorship

12 November 2026. **Passed** on the existing Sepolia account using local PostgreSQL v3 storage and the bounded local relayer (not AVNU). Four paid attempts succeeded: [owner session approval](https://sepolia.voyager.online/tx/0x3cf1511e52169d7492a280ccd70315393fede2c9402959c6c39ca44742d623d), [approved-app Ping](https://sepolia.voyager.online/tx/0x6131830584adc23b746d802335825ed2951571b78331b9866882b2b6beb3893), [Google client-proof recovery](https://sepolia.voyager.online/tx/0x6d5b8c8d81ba7b3c21942646fa57c151952ab978540384b79aa0db19e2f3cd7), and [owner revoke-all](https://sepolia.voyager.online/tx/0x3acce144315d938c553d7024741aae44e0f0183c8298490e6f3d7fa23718987).

The user approved four paid attempts, 12 test STRK total and 5 per transaction. Actual fees totaled **2.116362690347488448 STRK**; signed maximum debits totaled **4.748786677424971200 STRK**. Pause survived PostgreSQL/API restart, a fresh unused-nonce call was refused while paused, and a temporarily tighter cap refused another fresh valid call without clearing history. An accepted recovery was still unfinished in PostgreSQL after API termination; restart reconciled the same hash while the browser recovered through nine failed status connections, with one relay submission observed.

Owners increased **4 → 5**, all previous owners retained, class unchanged. Recovery advanced session epoch **7 → 8**, invalidating the test session; revoke-all advanced it to **9**. Funding is finally **paused**, with all four debits/journal history, both device profiles and a private SQL backup retained. Ordinary legacy launch configuration and original SQLite files were not changed. No old owner removal, registry administrator handoff, AWS change or external AVNU-control validation occurred.

[Run details](run-12-postgres-regression.md), [structured evidence](run-12-postgres-regression.json), [receipts](run-12-receipts.json), [final funding state](run-12-funding-final.json).

## Run 13: native KMS k1 administrator

12 November 2026. **Passed.** The real AWS KMS k1 key signed an interoperability challenge, validated deploy/Ping query estimates and the normal deployment/Ping transactions. Four paid transactions (declaration, 2 STRK funding, deployment and Ping) all succeeded on canonical Sepolia blocks. Actual fees totaled **6.449947451955377354 test STRK**; the new account retains **1.11264942020197735 STRK**. Counter **12 → 13**, administrator nonce **2**. Full key/class and balance deltas match; changed-digest and different-key signatures were rejected by read-only calls.

The user explicitly removed Sepolia STRK caps before any paid submission. Durable hash/nonce reservations and receipt accounting remain active. Fixed RPC ABI-string class-hash normalization, covered by regressions; 86 TypeScript tests, 39 Python setup tests and typecheck pass. No registry authority handoff, user-account migration or hosting change. Custody/security and independent-recovery review remain open. [Run details](run-13-kms-admin.md), [public evidence](run-13-kms-admin.json).
