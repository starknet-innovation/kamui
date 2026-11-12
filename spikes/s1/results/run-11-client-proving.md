# Run 11 — live Google recovery with client-side V2 proving

12 November 2026. **Passed** for the existing Sepolia account. The Google token was executed and proved in browser Workers using pinned `snip-36-prover-wasm` v1.0.1, commit `32596db806409e8e24008cc922bc80ae164854b8`. The completed proof went through the durable relay; no hosted prover or new account class was used.

[Public evidence](run-11-client-proving.json). No JWT, pepper, device private key, signature, PIE, proof bytes, Google identity or browser profile is included in the artifact.

## Accepted transaction and account checks

[Recovery transaction](https://sepolia.voyager.online/tx/0x1c0f98c6d9d61d6ffde317cb256ef69a57f22b29cfa459321320dd390abe207), block **18,036,204**, `ACCEPTED_ON_L2` and `SUCCEEDED`, independently read from the public RPC.

| Check | Result |
|---|---|
| Account | `0x133739e82cd76b5a6446848ae0cbbbb8cc4762fbb8e0eb5ebc417209423e0e9` |
| New device public key | `0x802ba719b5e2c6c1c3c6600a6237e658ddc40ebfb9eb8872b7424dc13a0b08` |
| `is_owner(new_key)` | True |
| Owner count | 3 → 4; all three previous keys retained |
| Session epoch | 6 → 7 |
| Account class | Unchanged, `0x1e128dae2cb709cac9263afa1c6fdb33f7f1f5c2d969547d9739326d08399f6` |
| Relay submissions | One; no `/recover` server-proving call and no deployment call |
| Actual fee | 1.935060442125421920 test STRK |
| Reload | Returned to the account without another proof/relay; signed registry-list request returned 200 |

There were no live sessions before this test. The epoch change was verified; this run did not test invalidation of an active session signature. The RPC transaction lookup omits proof facts; the submitted facts in the artifact are captured from the browser relay request, not reconstructed from that lookup.

## Browser measurements and data path

The successful run used **headed bundled Chromium 153.0.8010.12**, Playwright bundle revision 1243, controlled through a loopback CDP connection. Current Google signing keys were checked against the on-chain registry before the run; both matched.

| Measurement | Result |
|---|---:|
| Authenticated acquisition, execution and PIE | 45.59 s |
| Execution Wasm linear memory | 215,416,832 bytes |
| PIE size, kept only in memory | 5,813,937 bytes |
| Recursive proving | 117.34 s |
| Proof size | 231,792 bytes |
| Prover Wasm linear memory | 3,574,595,584 bytes |
| Peak requested Rust allocations | 3,558,791,323 bytes |

These are one-run measurements, not device minima or browser RSS. The pinned prover hash, V2 program, circuit header and Sepolia OS config passed the client/relay checks, and the transaction succeeded on chain.

The existing-account relay request contained proof, facts and ownership authorization, **no JWT or pepper**. Ordinary pepper lookup still sent the token and device proof to the pepper service. Observed proving RPC methods were read-only; no private virtual transaction was sent for remote simulation/proving. No raw witness or sensitive response body was logged or retained by the observation harness.

## Attempts before the successful run

- Bundled Chromium 158.0.8127.18 crashed with native `EXC_BAD_ACCESS` during Google authentication, before any proof or API submission. Its headless public balance-fixture proof had passed previously; that does not establish headed authentication stability.
- A restored-profile attempt reached Kamui with a pending device key that did not match its saved login attempt. It was rejected before proving or a transaction. Multiple restored sign-in tabs were present; the root cause has not been isolated. A single-tab retry with the already authenticated Google account succeeded.

No application source change was needed for the successful run. The API, pepper and Google-only keychain were started locally. The successful test window remains open with its encrypted local vault; no private key was exported. Nothing was committed, pushed or deployed to AWS, and no GitHub message was posted.

## Not established

First-account deployment with client proving; recovery-file/pepper-outage flows with V2; a lost-response or API-restart fault during this live client-proof submission; installed Google Chrome, mobile, Safari or Firefox proving; production hosting or readiness. The native Chromium crash and restored-tab attempt mismatch remain follow-up items.
