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
