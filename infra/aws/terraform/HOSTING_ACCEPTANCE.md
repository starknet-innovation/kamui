# Sepolia hosting review and acceptance record

Companion to [HOSTING_REVIEW.md](HOSTING_REVIEW.md), prepared 12 November 2026. **User product/storage choices below are recorded; technical approvals and AWS deployment remain pending.** Empty checkboxes mean pending, not failed tests. Use private references for account/resource identifiers and sensitive evidence; never paste secrets, tokens, recovery files, private keys, account IDs or resource identifiers into this record.

## Review decisions

| Decision | Named owner | Recorded answer / private evidence reference | Status |
|---|---|---|---|
| R1 Beta scope and origins | User; technical reviewers unassigned | Open Sepolia beta, Google only, `sepolia.kamui.page` + `pepper-sepolia.kamui.page` | Scope selected; release/DNS review pending |
| R2 Accounts/Region, deployment roles, KMS/SCP/audit ownership | Unassigned | Existing two accounts, two EC2 servers, eu-west-1 estimate; supersedes Fargate | Baseline selected; technical review pending |
| R3 Database design and backup/restore guarantees | User selected direction; database reviewer unassigned | PostgreSQL on backend EC2 server; supersedes RDS | Direction selected; implementation/storage review pending |
| R4 Ingress, DNS/proxy, client-address and abuse controls | Unassigned | Direct HTTPS on EC2, Cloudflare DNS-only, local-only API/database; replacement edge controls pending | Direction selected; implementation/effectiveness pending |
| R5 Release digests, architecture, licences, Wasm profile and browser resources | Unassigned | Pending | Not approved |
| R6 Signer ownership, registry governance, nonce writers and funding limit | Unassigned | Pending | Not approved |
| R7 App approval, sponsorship limits and incident handling | Unassigned | Approved apps only; anonymous sponsorship off; per-app/per-account/overall limits | Policy selected; thresholds, durable counters and external AVNU controls pending |
| R8 JWT/log/registry privacy and vendor/Region review | Unassigned | Pending | Not approved |
| R9 Budget, operator, alerts, maintenance and restore ownership | Unassigned | Public-rate estimate in COST_ESTIMATE.md; no ceiling or reviewers supplied | Estimate/approval pending |

Review approval means the design may proceed to its specifically approved implementation/deployment stage. It is not a mainnet or general-production sign-off.

## Before an account-aware plan

- [ ] Production service packaging exists; no startup bundling or developer secret-file fallback is required.
- [ ] Keychain health, body limits, approved API routes, timeouts and sanitized errors are implemented and tested.
- [ ] Browser RPC configuration is explicitly public and distinct from any credential-bearing backend RPC URL.
- [ ] Local-only API/database, keychain-only API routing, process isolation and metrics denials are implemented.
- [ ] EC2 provisioning and service definitions include watcher and API-only AVNU secret delivery; no secret values enter variables, state or build arguments.
- [ ] Google-only configuration works with no new Apple configuration; the keychain option remains hidden.
- [ ] Every image/binary matches its host architecture. Complete Wasm/Worker/glue assets and profile are pinned together with hashes and notices; no mutable remote scripts.
- [ ] Client-side execution/proving and durable proof relay are implemented. Hosted prover task, private port/discovery, prover-account secret, API dependency and public server-proving routes are absent from the target.
- [ ] First deployment still verifies identity/pepper before sponsorship; an unguarded client-chosen pepper cannot consume paid deployments.
- [ ] Offline Terraform/schema checks, image scans and relevant application tests pass; findings are reviewed.
- [ ] Selected local PostgreSQL migration is implemented and reviewed, including admission/nonce/intent transactions, cutover and restore. One API process remains until other shared-state/signing constraints are addressed.
- [ ] A private account-aware plan and its reviewer have been designated. No agent-created cloud account or security changes are authorized by this checklist.

## Private deployment checks — operator records results

- [ ] Account, Region, access path and least-privilege deployment scope match R2. Terraform state and plan files stay private.
- [ ] Pepper uses the existing approved **test** key and expected check value; its process uses only the designated EC2 role and reviewed credential path.
- [ ] No unrelated principal gains MAC access; tampering/volume/audit alarms are delivered and tested using an owner-approved procedure.
- [ ] HTTPS certificates validate both selected names; automated renewal and failure alerts are tested. DNS targets are the operator-provisioned server addresses.
- [ ] API, rotator and watcher targets cannot be reached from the public internet or the wrong service.
- [ ] `/metrics` and `/api/metrics`, including suffix variants, are denied publicly; the internal scraper still works.
- [ ] A hostile leading `X-Forwarded-For` value cannot choose a rate-limit identity. Two real clients remain separate through HTTPS proxy → keychain → API; the proxy overwrites untrusted forwarded headers.
- [ ] The keychain config contains only approved public values; browser assets and container layers contain no credential/recovery file.
- [ ] Logs, traces, error responses and alert payloads contain no JWT, pepper, proof, signature, API key or request body. Review sample failures too.
- [ ] Local PostgreSQL stores both logical datasets with reviewed access and transaction semantics. Process/container and server restart retain session records and recovery locks/results; frontend/workers have no database credentials.
- [ ] Database backup/restore and SQLite-to-PostgreSQL cutover are tested on a disposable copy, including admission fencing and data verification. The plan for stale recovery intents is recorded.
- [ ] Exactly one API writer runs through a replacement. Stop the API for operator reconciliation; no second instance/CLI is treated as an independent writer.
- [ ] Public asset delivery uses correct Wasm/Worker MIME and tested CSP/cache/versioning. Measure compressed transfer and first-load/cached behavior; never cache witnesses.
- [ ] Rotator updates and watcher lag/mismatch/fetch-failure alerts are verified independently; signer identities and nonce ownership are understood.
- [ ] Approved-app authentication, anonymous-off policy, durable budget/debit state and separate relayer deploy/recovery limits are implemented and survive restart.
- [ ] Replacement edge controls, rate limits, large-proof requests and redacted logging are reviewed and tested; direct EC2 has no ALB-associated WAF. Host controls are not equivalent to upstream protection or a spend cap.
- [ ] AVNU is explicitly selected, its key stays API-side, and the external operator's spending controls and current terms are verified.
- [ ] Secret rotation is tested through service replacement; a running process is not assumed to reload values automatically.

- [ ] Load test PostgreSQL plus all backend services on 2 GiB; measure memory, CPU credits, disk usage and proof-upload spikes. Resize if needed.
- [ ] Off-host base backups and WAL archiving work; failure/lag alarms and a disposable restore drill validate agreed RPO/RTO. Retention still requires a decision.
- [ ] Restoring stale data leaves relaying/sponsorship/rotator writes fenced until signer history, active locks, replay state and budget debits are reconciled. Missing rows do not authorize retries.
- [ ] Host patching, service restart, certificate renewal, disk-full alerts and recovery after server loss have an assigned operator and tested procedure.

## HTTPS Google pilot checks

- [ ] `https://sepolia.kamui.page/config.json` has the exact Google callback, current class, public RPC and reviewed pepper URL; no localhost or credential-bearing URL leaks.
- [ ] CSP/no-frame/no-store/referrer headers remain present. There is no third-party script, analytics, session replay or injected keychain content.
- [ ] Exact Google redirect URI is registered on the intended existing client; public-beta audience/consent/verification settings are approved by the OAuth owner. Do not change client ID to fix a redirect error.
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
- [ ] The owner can stop admission, pause sponsorship and restore service deliberately. Fixed EC2/disk/IP and backup charges remain in the approved budget.
- [ ] Paging, spending/health/lag alarms, maintenance responsibility and incident contact are verified with real recipients by the authorized operator.
- [ ] The measured recurring-cost worksheet, test-data retention and follow-up date are recorded.

## Current evidence, without approval

- Repository review baseline: `3ba7a39`.
- Local `terraform fmt -check -recursive`: passed on 12 November 2026 (Terraform 1.15.5). Revised backend validation is blocked by absent installed module metadata; no init was run.
- Client-proving target: upstream v1.0.1 / `32596db806409e8e24008cc922bc80ae164854b8` inspected; Kamui integration and existing-account Google V2 recovery passed in local run 11 with Chromium 153; broader resource/browser, first-deployment and hosted-origin acceptance remain pending. The older Docker prover is excluded from the proposed stack.
- Public documentation checked; AWS accounts, plan/apply, DNS and Google settings untouched.
- User selected an open Sepolia beta and subsequently chose two EC2 servers with PostgreSQL on the backend server to reduce cost. This supersedes Fargate, RDS and the ALB/WAF layout; DNS-only, Ireland and approved-app sponsorship remain. Public rates/scenarios are recorded in COST_ESTIMATE.md; reviewer names, budget ceiling, technical approvals, implementation deltas and hosted acceptance remain pending.

## Local PostgreSQL implementation evidence — 12 November 2026

PostgreSQL registry/recovery adapters, asynchronous commit-before-send, explicit read-only-source SQLite import, versioned schema and same-connection single-writer lease are implemented. Disposable local PostgreSQL 16 tests cover concurrency, replay, import rollback and uncertain recovery receipts. No existing developer database was migrated; no AWS deployment, hosted acceptance, off-host backup/restore drill or physical power-loss test was performed. Durable spending counters and the remaining lean EC2 packaging are still pending. Application use remains strictly stop-old-before-start-new; a SQL lease cannot fence an already-prepared Starknet send.
