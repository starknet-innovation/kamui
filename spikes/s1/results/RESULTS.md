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
