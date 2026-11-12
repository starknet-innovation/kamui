# Client-side recovery proving

Decision, 12 November 2026: Kamui will prove in the keychain browser using [snip-36-prover-wasm](https://github.com/starknet-innovation/snip-36-prover-wasm). No hosted prover or automatic server-proving fallback is part of the proposed deployment. **Existing-account Google V2 recovery passed live on Sepolia (run 11).** The keychain now executes and proves in dedicated browser Workers, then submits the completed proof through the durable `/relay` job. The public API rejects server-proving `/recover` requests. Runs 1–10 used the older backend flow. [Run 11](../spikes/s1/results/run-11-client-proving.md) validates browser proving and enrollment of a new device on the existing account; first deployment and recovery-file outage with V2 remain pending.

## Source and compatibility baseline

The inspected upstream HEAD and local checkout agree on commit `32596db806409e8e24008cc922bc80ae164854b8`, release v1.0.1. Its [profile](https://github.com/starknet-innovation/snip-36-prover-wasm/blob/32596db806409e8e24008cc922bc80ae164854b8/web/prover-profile.mjs) targets backend v1.4.2/deps-v16, the Starknet 0.14.4 V2 circuit and `PROOF2`, with virtual OS program `0x1c7be3225dfb33359b3ba9ffbe1542b7da27879b6d89f47b967e512463fd324`. The Sepolia V4 OS config is pinned to `0x57ed4d5e20d617d8cc087a5882eae4f71d005172326be6439b2e1fd8b4dc57` alongside the circuit/program; it derives from the config version, chain ID and STRK fee token, not block state. Profile/network upgrades must review these pins together. The supported `standard` build is the memory-optimized V2 build; the historical V1 `memory` build is disabled. Retain Apache-2.0 `LICENSE` and `THIRD_PARTY_NOTICES.md` with all distributed assets. Licence/security review remains required.

Kamui's old [browser spike](../spikes/s1/social-account/client/src/sdk/prover/local-prover.ts) uses `PROOF1` and obsolete build selection. It is reference material, not a compatible drop-in. The backend [relay](../services/backend/src/services/recovery/relay.ts) now accepts only the pinned `PROOF2` header and virtual-program identity, checks the expected facts shape and recovery message against the live account, pins the Sepolia OS config and leaves cryptographic proof admission to the gateway. Tampered profiles must be rejected before a paid send; do not broaden accepted proof versions as a compatibility fix. Gateway verification must still validate the proof before recovery executes.

The [contract facts parser](../contracts/src/social/proof_facts.cairo) reads the version without enforcing `PROOF1`, and checks the virtual-OS variants and recovery message. Run 11 proved the actual `prove_jwt` workload and recovered the existing Sepolia account with its unchanged immutable class; no new class/address was required for this test. Upstream's successful CoinFlip validation is not a Kamui JWT compatibility test.

## Implemented flow and remaining validation

1. Create/use the device key inside the keychain origin. Obtain a Google token whose nonce binds the new public key and blinding. Obtain the pepper using the existing device-proof flow, or read the user's recovery file locally.
2. For a first deployment, `POST /deploy/authenticated` receives the token and device proof, verifies the identity and nonce, derives the account itself, and confirms the pepper before paying. It runs as a durable deployment job with hourly/IP caps and does no proving. Legacy unauthenticated `/deploy` is rejected. Already-deployed accounts skip this authentication request entirely. A design that also keeps this token from the API needs a separately reviewed, bound, expiring, single-use deployment authorization from the pepper service. Do not repurpose its HMAC key for a new signing protocol.
3. Read chain state from a reviewed public RPC, using a fixed eligible block and the public prover executor. Construct the private virtual transaction in the browser, including JWT, pepper, registered JWK hints and the current owners anchor. Never upload the private virtual transaction to a remote executor or RPC for simulation.
4. Execute and prove in dedicated Workers using the pinned upstream modules. Bind the output message to this account, identity, key, chain and anchor before submitting. Show download, execution, proving and submission progress; handle token expiry, cancellation and memory exhaustion explicitly.
5. Send only the completed proof, facts and required recovery authorization to the API. The API validates them, journals a signed transaction before broadcast, returns a capability-protected job and reconciles the receipt. The browser polls submission status. Proving itself is local work, not a backend job.
6. A page/Worker exit before submission requires a fresh sign-in/proof. Once submitted, a lost response/restart must reconcile the same attempt before another paid transaction. Preserve the existing conservative unresolved-intent locks.

`POST /relay` now takes a random `jobId` with the proof request and returns `202 { jobId }`; both relay and authenticated deployment poll `POST /recover/status`. Identical submissions with the same capability join their original job. JWTs, pepper, private execution input, PIE, signatures and proof bytes stay out of the journal; only request fingerprints and transaction metadata persist. See [RECOVERY-JOBS.md](../services/backend/RECOVERY-JOBS.md). An orphaned job interrupted before broadcast fails as `RECOVERY_INTERRUPTED`; start a fresh sign-in after checking status. A journaled but uncertain send stays locked rather than being broadcast again.

## Browser assets, memory and private data

The pinned JavaScript modules and licence notices are in [prover/](prover/README.md); the two large Wasm files are gitignored. Before starting the keychain, install and verify them using the supported Bun binary:

```sh
cd keychain
bun scripts/prover-assets.ts             # download and verify the pinned release binaries
bun scripts/prover-assets.ts --check     # offline verification of every pinned runtime asset
# Or install verified binaries from an existing upstream checkout:
bun scripts/prover-assets.ts /path/to/snip-36-prover-wasm
```

The keychain verifies and snapshots every asset at startup, then serves only exact manifest entries under `/prover/v1.0.1/` after checking the whole bundle. A missing or changed asset disables new-device sign-in before OAuth or paid deployment; an existing owner can still use wallet flows that require no proof. No browser runtime import contacts GitHub or a CDN. `proverRpcUrl` is the exact public ZAN Sepolia endpoint required by the unchanged upstream transport. General wallet reads use `PUBLIC_RPC_URL` (or an explicit development `RPC_URL`); the keychain no longer falls back to the backend secret RPC setting. The prover loader also verifies its expected Wasm hash and byte count. A release build must include the verified binaries, complete JavaScript graph and licence notices.

Self-host the pinned Worker/glue/executor/prover bundle on the keychain origin. Pin the complete dependency graph and manifest, verify artifacts at build time and at the upstream loader boundary, and use versioned asset URLs so deployments cannot mix circuits. Do not load mutable third-party scripts or a runtime GitHub/CDN bundle into the wallet origin.

The release manifest lists 36,330,443 executor bytes and 76,749,727 prover bytes: **113,080,170 bytes (about 108 MiB)** before glue/other assets. Measure compressed transfer, first-load time, cache behavior, request limits and bandwidth costs. Cache only versioned public code/assets; never cache sensitive execution data or callback/config responses. Rollback must pin a compatible whole bundle and relay profile together.

Upstream requires a recent memory64-capable desktop Chromium and recommends at least 8 GB of device RAM for its measured fixtures. Its V2 balance replay used about 3.2 GB of wasm linear memory; that is not a Kamui `prove_jwt` measurement or a promise of mobile, Safari or Firefox support. Detect unsupported browsers before login/proof work and explain the limitation. Do not silently send the token to a server. Returning-owner flows that need no proof are a separate browser capability from new-device recovery; test each explicitly.

Use the upstream controller/Workers with a nonpersistent `save` callback. Do not integrate the public replay-lab's receipt storage or logging: requests, captures and PIE can contain the private witness. Do not put these in IndexedDB, localStorage, service-worker caches, analytics, downloads or error telemetry. Terminate Workers and release references on success/cancel/failure; JavaScript cleanup does not guarantee physical memory erasure.

The server adds same-origin `worker-src` and `wasm-unsafe-eval` for Wasm compilation, without generic `unsafe-eval`. Garaga 1.1.0 embeds its RSA-hint module as a data URL; `connect-src data:` permits that local embedded module, not an external network recipient. Wasm is served as `application/wasm`; pinned public assets have immutable caching while config/callback responses remain no-store. Framing/referrer/callback protections remain required. Test this complete policy on the supported browser before hosted acceptance; no speculative cross-origin isolation headers are added.

Client-side proving changes who computes the proof, not every data recipient. Google issues the token; the pepper service sees it during ordinary pepper lookup; first-deployment authentication may also send it to the API as described above. A recovery-file path can avoid pepper lookup. Read-only RPC requests reveal account/state access. Review network traces, logs and error paths before making privacy claims. The party serving the keychain still controls code at sign-in.

## Remaining acceptance gates

1. Review the pinned release, Worker adapter, cancellation/capability behavior and memory-only input/output handling. The old spike is not part of the keychain bundle.
2. Expand the run 11 public executor/state acquisition and V2 JWT measurements across supported hardware and repeat expiry/failure tests. One Chromium 153 run passed; it does not establish general device/browser availability.
3. Review authenticated first deployment and durable proof-submission/status handling together. The API no longer loads a prover account or URL, Terraform excludes the hosted prover and its credential, and Compose keeps the old Docker service behind an explicit historical profile. Confirm that deployment packaging has no active server-proving fallback.
4. Run focused Worker/profile/privacy tests and browser failure cases; then the remaining live Sepolia first deployment, pepper-file recovery, stale anchor/expired token rejection, lost response and API restart after broadcast. Record accepted transaction receipts and exact bundle/profile identities.
5. Only then ship the hosted Google pilot described in [HOSTING_REVIEW.md](../infra/aws/terraform/HOSTING_REVIEW.md). Review the security changes and data-handling claims with the wallet/security and privacy owners. No production readiness or all-browser support is implied by the plan.

Local validation, real public-fixture measurements and remaining live/browser limits are recorded in [CLIENT_PROVING_VALIDATION.md](CLIENT_PROVING_VALIDATION.md).
