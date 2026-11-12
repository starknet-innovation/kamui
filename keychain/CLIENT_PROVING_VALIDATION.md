# Client-proving validation — 12 November 2026

Existing-account Google recovery now passed live on Sepolia in [run 11](../spikes/s1/results/run-11-client-proving.md). No commit, push or cloud deployment was performed. The API and Google-only keychain were restarted on ports 3000 and 5173 with the new code. The unused local Docker prover was stopped. The live test enrolled one new browser device, retained all three prior keys, and advanced the session epoch from 6 to 7.

## Checks completed

- 109 SDK tests and TypeScript pass. Coverage includes JWT-free existing-account relay, first-deployment authentication, unchanged idempotency capability after a lost response, malformed V2 output, expiring tokens, changed owners anchor and no server fallback.
- 158 backend tests and TypeScript pass. The new cases cover V2 profile/output binding, authentication/pepper confirmation/caps, journal secrecy, duplicate/conflicting submissions, lost broadcast response, accepted-receipt reconciliation after reopen, and sanitized upstream failures.
- The initial UI matrix ran 213 cases: 203 passed, three opt-in runtime cases skipped, six CSP/network expectations needed updating for Wasm/public acquisition, and one installed-Chrome context closed during the dropped-status test. The corrected security/login group passed all 24 targeted cases across Chromium/Firefox/WebKit; Chrome used the bundled Chromium for that rerun. All 21 current prover failure-path cases passed across those browsers, including cancellation/deadline during preparation and missing assets before paid work. A final 12-case rerun covered the early capability/asset guards, new-device sign-in and stale sign-in page after the final changes; all passed. Those UI tests replace the prover with a test double; they do not establish Firefox/WebKit proving support.
- Four public-origin server tests, keychain TypeScript, complete pinned-asset verification, relative documentation links and `git diff --check` pass. Terraform formatting passes. Offline Terraform validation could not complete because local module installation metadata is absent; no account APIs or plan/apply were used.

## Real Worker proof

[Recorded public runtime measurements](../spikes/s1/results/client-proving-runtime-2026-11-12.json) came from the opt-in [runtime test](tests/prover-runtime.spec.ts) against the keychain's actual pinned asset server and CSP. It executes upstream's public balance capture offline, then proves in real Workers. It does not use a JWT, device key, remote prover or paid transaction.

- Upstream v1.0.1, commit `32596db806409e8e24008cc922bc80ae164854b8`, V2 standard build; the expected Wasm hash, byte count and full 35-byte circuit header matched.
- Proof: 231,440 bytes; recursive proving: 71.01 seconds; execution: 2.26 seconds.
- Wasm linear memory: 3,203,596,288 bytes; peak requested Rust allocations: 2,347,735,761 bytes. These are different metrics; neither is a measured browser RSS or Kamui JWT requirement.
- Playwright's bundled Chromium 158.0.8127.18 completed successfully. Its Desktop Chrome preset supplies the user-agent recorded in the JSON; the user-agent is not host OS evidence.
- The installed Google Chrome process closed with a native SIGSEGV during this runtime test. Reducing Docker memory pressure and launching with a clean child environment did not resolve that installation's failure. It is not a passing installed-Chrome proof test. The initial 33-byte header assertion was also corrected to the pinned 35-byte header and the real bundled-browser run then passed.

Reproduce with a pinned upstream checkout containing the public fixture, from `keychain/` after installing/verifying assets and the Playwright Chromium build:

```sh
KAMUI_TEST_BUNDLED_CHROMIUM=1 SNIP36_SOURCE=/path/to/snip-36-prover-wasm \
  BUN=/path/to/current/bun ./node_modules/.bin/playwright test --project=chrome prover-runtime.spec.ts
```

The test writes public measurements to its ignored output directory. To use an already running local keychain for this **runtime test only**, set `KAMUI_TEST_EXTERNAL_ORIGIN=http://localhost:5173`. Other UI tests rely on their isolated fake-service origins and must use the default test server.

## Still required

Run 11 proves the actual Kamui `prove_jwt` workload on the existing account in headed bundled Chromium 153.0.8010.12: 231,792 proof bytes, 117.34 s proving and 3,574,595,584 bytes Wasm linear memory. The recovery succeeded on Sepolia and the new owner survived reload. The earlier public balance artifact itself was not separately submitted or natively verified during this integration task.

Still run first deployment, recovery-file/pepper-outage, expiry/failure and live lost-response/API-restart cases with V2. Broader device measurements, native browser crash investigation and the restored-tab pending-key mismatch also remain open. See the run record for scope and exact evidence.

Installed-Chrome proving remains unresolved on this machine. Mobile, Safari and Firefox proving are unverified; UI tests and a memory64 feature probe are not availability guarantees. Hosting, security/privacy review and natural Safari storage expiry are still pending as described in [CLIENT_PROVING.md](CLIENT_PROVING.md) and the hosting review packet.
