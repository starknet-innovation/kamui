# Sepolia hosting review and acceptance record

Companion to [HOSTING_REVIEW.md](HOSTING_REVIEW.md), prepared 12 November 2026. **No reviewer approval or AWS deployment has occurred.** Empty checkboxes mean pending, not failed tests. Use private references for account/resource identifiers and sensitive evidence; never paste secrets, tokens, recovery files, private keys, account IDs or resource identifiers into this record.

## Review decisions

| Decision | Named owner | Recorded answer / private evidence reference | Status |
|---|---|---|---|
| R1 Pilot scope, Google-only cohort, test origins | Unassigned | Pending | Not approved |
| R2 Accounts/Region, deployment roles, KMS/SCP/audit ownership | Unassigned | Pending | Not approved |
| R3 Database design and backup/restore guarantees | Unassigned | Pending | Not approved |
| R4 Ingress, DNS-only/proxy choice, client-address and abuse controls | Unassigned | Pending | Not approved |
| R5 Release digests, architecture, licences, Wasm profile and browser resources | Unassigned | Pending | Not approved |
| R6 Signer ownership, registry governance, nonce writers and funding limit | Unassigned | Pending | Not approved |
| R7 AVNU API-key ownership, fee/period limits and incident handling | Unassigned | Pending | Not approved |
| R8 JWT/log/registry privacy and vendor/Region review | Unassigned | Pending | Not approved |
| R9 Budget, operator, alerts, maintenance and restore ownership | Unassigned | Pending | Not approved |

Review approval means the design may proceed to its specifically approved implementation/deployment stage. It is not a mainnet or general-production sign-off.

## Before an account-aware plan

- [ ] Keychain production image/runtime exists; no startup bundling or local secret-file fallback is required.
- [ ] Keychain health, body limits, approved API routes, timeouts and sanitized errors are implemented and tested.
- [ ] Browser RPC configuration is explicitly public and distinct from any credential-bearing backend RPC URL.
- [ ] Private API routing, keychain-only API ingress, internal-port egress and metrics denials are implemented.
- [ ] Watcher service and API-only AVNU secret injection are in Terraform; no secret values enter variables, state or build arguments.
- [ ] Google-only configuration works with no new Apple configuration; the keychain option remains hidden.
- [ ] Every image matches its task architecture. Complete Wasm/Worker/glue assets and profile are pinned together with hashes and notices; no mutable remote scripts.
- [ ] Client-side execution/proving and durable proof relay are implemented. Hosted prover task, private port/discovery, prover-account secret, API dependency and public server-proving routes are absent from the target.
- [ ] First deployment still verifies identity/pepper before sponsorship; an unguarded client-chosen pepper cannot consume paid deployments.
- [ ] Offline Terraform/schema checks, image scans and relevant application tests pass; findings are reviewed.
- [ ] Storage choice and a no-overlapping-writer deployment procedure are approved.
- [ ] A private account-aware plan and its reviewer have been designated. No agent-created cloud account or security changes are authorized by this checklist.

## Private deployment checks — operator records results

- [ ] Account, Region, access path and least-privilege deployment scope match R2. Terraform state and plan files stay private.
- [ ] Pepper uses the existing approved **test** key and expected check value; its task starts only under its designated KMS role.
- [ ] No unrelated principal gains MAC access; tampering/volume/audit alarms are delivered and tested using an owner-approved procedure.
- [ ] Certificate names/Regions are correct and validation completed. DNS targets come from the deployed ALBs, not example values.
- [ ] API, rotator and watcher targets cannot be reached from the public internet or the wrong service.
- [ ] `/metrics` and `/api/metrics`, including suffix variants, are denied publicly; the internal scraper still works.
- [ ] A hostile leading `X-Forwarded-For` value cannot choose a rate-limit identity. Two real clients remain separate through ALB → keychain → API.
- [ ] The keychain config contains only approved public values; browser assets and container layers contain no credential/recovery file.
- [ ] Logs, traces, error responses and alert payloads contain no JWT, pepper, proof, signature, API key or request body. Review sample failures too.
- [ ] API storage holds both databases with expected user/permissions and journal mode. Stop/start of a task retains session records and job locks/results.
- [ ] Backup/restore is application-consistent and tested on a disposable database copy; include journal sidecars where applicable. The plan for stale recovery intents is recorded.
- [ ] Exactly one API writer runs through a replacement. Stop the API for operator reconciliation; no second instance/CLI is treated as an independent writer.
- [ ] Public asset delivery uses correct Wasm/Worker MIME and tested CSP/cache/versioning. Measure compressed transfer and first-load/cached behavior; never cache witnesses.
- [ ] Rotator updates and watcher lag/mismatch/fetch-failure alerts are verified independently; signer identities and nonce ownership are understood.
- [ ] AVNU is explicitly selected, its key stays API-side, and the external operator's spending controls and current terms are verified.
- [ ] Injected-secret rotation is tested through task replacement; a running task is not assumed to reload the value automatically.

## HTTPS Google pilot checks

- [ ] `https://sepolia.kamui.page/config.json` has the exact Google callback, current class, public RPC and reviewed pepper URL; no localhost or credential-bearing URL leaks.
- [ ] CSP/no-frame/no-store/referrer headers remain present. There is no third-party script, analytics, session replay or injected keychain content.
- [ ] Exact Google redirect URI is registered on the intended existing client; tester/consent settings match the approved cohort. Do not change client ID to fix a redirect error.
- [ ] Local Ping → HTTPS keychain → local Ping round trip works, or a separately reviewed demo origin is used. App/session keys stay at their respective origins.
- [ ] First sign-in at the HTTPS origin reaches the expected account. Returning-device sign-in skips proving; a new-device sign-in ends sessions as D5 specifies.
- [ ] V2 `prove_jwt` succeeds locally in the supported browser and the existing Sepolia account accepts its recovery. Record profile, facts, peak memory, time and receipt; upstream CoinFlip evidence is insufficient.
- [ ] Network traces confirm no JWT/pepper/private execution/PIE is sent to a proving server or RPC simulation; expected pepper and first-deployment authentication recipients are documented. No private replay-lab storage or telemetry.
- [ ] Unsupported browser, token expiry, out-of-memory and user cancellation have clear outcomes, terminate Workers and never invoke server proving. Returning-owner flows are tested separately.
- [ ] Dropping a proof-submission response reconciles the same job; only one recovery is paid. No bearer job ID appears in URLs/logs.
- [ ] Closing/reloading during browser proving gives fresh-sign-in instructions and leaves no witness/PIE persistence. Restarting the API does not interrupt browser proving or cause a server fallback.
- [ ] Interrupted pre-broadcast proof submission has a defined safe retry path; the durable metadata excludes JWT, pepper, proof and raw capabilities.
- [ ] Restart after a journaled send reconciles the exact accepted transaction hash. Missing or pre-confirmed receipts retain the lock; an accepted revert is a failure.
- [ ] AVNU owner approval and a session ping confirm; record external actual fee against the local preflight. Scope, nonce replay, fee preflight and budget refusals are checked.
- [ ] Lost sponsorship response is reconciled before any manual retry; the paid attempt remains debited.
- [ ] Revoke-all and stale-device removal work; removed key/session signatures fail while a retained owner still works.
- [ ] A privately exported recovery file signs into the same existing account while pepper is stopped; verify the outage through confirmation, then restore and verify pepper.
- [ ] Start the benign Safari storage probe on a reviewed HTTPS test origin. Native reload mechanics and a modeled deletion are separate from the naturally elapsed Safari-use-day expiry trial.

Local Sepolia evidence already exists for several flows in [runs 9 and 10](../../../spikes/s1/results/RESULTS.md). Repeating them on the hosted origin validates the new deployment boundaries; the prior runs are not claimed as cloud acceptance.

## Rollback and operational handoff

- [ ] Reviewed previous image digests and compatible configuration/database versions are recorded.
- [ ] API rollback preserves unresolved journal intents; a pre-journal API or stale snapshot cannot silently bypass them.
- [ ] A stopped-API, independently verified finalized-replacement drill exercises the operator resolution tool without inventing transactions or clearing rows blindly.
- [ ] The owner can stop admission, pause sponsorship and restore service deliberately. Fixed NAT/ALB/other charges remain in the approved budget.
- [ ] Paging, spending/health/lag alarms, maintenance responsibility and incident contact are verified with real recipients by the authorized operator.
- [ ] The measured recurring-cost worksheet, test-data retention and follow-up date are recorded.

## Current evidence, without approval

- Repository review baseline: `3ba7a39`.
- Local `terraform fmt -check -recursive`: passed on 12 November 2026 (Terraform 1.15.5). Revised backend validation is blocked by absent installed module metadata; no init was run.
- Client-proving target: upstream v1.0.1 / `32596db806409e8e24008cc922bc80ae164854b8` inspected; Kamui integration and existing-account Google V2 recovery passed in local run 11 with Chromium 153; broader resource/browser, first-deployment and hosted-origin acceptance remain pending. The older Docker prover is excluded from the proposed stack.
- Public documentation checked; AWS accounts, plan/apply, DNS and Google settings untouched.
- Reviewer names, cost rates/ceiling, implementation deltas and hosted acceptance: all pending.
