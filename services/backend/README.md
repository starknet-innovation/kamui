# Kamui backend

The services behind a login: the API that authenticates deployments and relays browser-generated proofs, the rotator that keeps the on-chain key registry in step with Google and Apple, and the watcher that checks the rotator's work. The api also sponsors transactions and keeps the session registry.

It started as upstream's backend (keep-starknet-strange/social-account, MIT). The Kamui changes are listed in `THIRD_PARTY.md`. It has had one audit pass (findings #2, #3 and #4 are fixed here) and is not production-ready: see "Not done".

## What it does

| Part | What it does |
|---|---|
| `POST /recover` | Disabled on the public API: `410 CLIENT_PROVING_REQUIRED`. Historical server-proving code remains for regression tests only. |
| `POST /recover/status` | Takes `{ jobId }` and returns a running job, its successful result, or its terminal error. |
| `POST /relay` | Takes a client-generated `jobId` and completed pinned V2 proof, validates recovery bindings, and returns `202 { jobId }`. A durable job journals the paid recovery before broadcast. No JWT or pepper is sent to this route. |
| `POST /deploy/authenticated` | Authenticates the token and device nonce, derives the account and confirms the pepper before a capped paid deployment; returns a polled durable job. No server proving. |
| `POST /deploy` | Legacy unauthenticated deployment is disabled: `410 AUTHENTICATED_DEPLOYMENT_REQUIRED`. |
| `POST /sponsor` | The relayer pays for an `execute_from_outside_v2` call on a Kamui account, out of a budget. The default development relayer, or the optional AVNU transport (Sepolia only; see `PAYMASTER.md`). |
| `POST /registry/sessions`, `/list`, `/remove` | The session registry: which sessions an account approved, and for which site. |
| `GET /health/api`, `/health/prover`, `/health/rotator`, `/live` | Health. `/live` depends on nothing. |
| `GET /metrics` | Prometheus text, on its own port (9464). |
| Prover | Runs only in the keychain browser. The old Docker service is an opt-in historical Compose profile, not an API dependency. |
| Rotator | Copies the issuers' current signing keys into the on-chain registry. |
| Watcher | Checks every key written to the registry against the issuer's published keys, and alerts. |

Request errors are a non-2xx status with `{ "error": "CODE" }`. Once a recovery job is accepted, its error is returned by the status route as described below.

## The pepper

When `PEPPER_SERVICE_URL` is set and a request would deploy a new account, `/deploy/authenticated` first asks the pepper service for the pepper of the request's token, using the key proof the client sends (`keyProof`), and refuses unless it equals the pepper the client sent. Nothing is deployed before that. The server never proves the token.

- **Only before a deployment.** An account that already exists is not confirmed with the pepper service: its address was derived from that very pepper, and `prove_jwt` checks the identity again on chain. This is what lets a user sign in from a recovery file when the pepper service is unavailable or lost.
- On mainnet the service is mandatory and pepper 0 is always refused, for new and existing accounts. The api does not start on mainnet without `PEPPER_SERVICE_URL`.
- On a testnet without the service, any pepper is accepted, including 0.
- If the pepper service is down, an accepted job that needs a deployment fails with `httpStatus: 502`. It never falls back to accepting the pepper.

Why: the client picks the pepper it sends, and the pepper decides which account address gets deployed. Without the check, anyone holding a valid token could make the relayer deploy accounts for made-up peppers.

## What one request can cost

Every POST route goes through the same wrapper (`src/services/api/app.ts`):

1. **Rate limits**, before the body is read: attempts per minute per client, then for everyone. Defaults: recover 6 / 60, poll 120 / 6000, relay 10 / 120, deploy 6 / 60, sponsor 30 / 600, registry 60 / 1200 (`RATE_LIMITS`). A refusal is `429 RATE_LIMITED`. These bound attempts; the hourly caps and budgets behind them bound spending.
2. **The handler**, which checks everything it can from the request alone before calling anything.
3. **Deadlines** on every outbound call: issuer keys 5 s, pepper service 10 s, each RPC request 30 s (`RPC_TIMEOUT_MS`), health probes 3 s.

The limiter is one interface (`src/limiter.ts`) with an in-process implementation. With more than one api process, implement it over a shared store.

**The client** is the socket's peer unless `TRUSTED_PROXY_HOPS` says how many of our own proxies are in front; then it is that many entries from the right of `X-Forwarded-For`. The keychain's `/api` proxy and any load balancer must append the address they saw, or every user shares one bucket.

### Deployment authentication (audit finding #3)

The token's issuer, audience, expiry and device-bound nonce are checked before outbound calls. The issuer's keys come from `JwksCache`: at most one fetch per five minutes per issuer, shared concurrent misses, and bounded refreshes for unknown key IDs. Unavailable keys fail closed. A valid token does not bypass pepper confirmation, account-address derivation or deployment caps.

An existing-account browser recovery skips deployment authentication and sends no JWT or pepper to the API. The pepper service still sees the token during normal lookup, unless the user signs in using a locally read recovery file. Client-side proving is not a claim that the token never leaves the browser.

### Recovery job protocol

The SDK generates a random 31-byte `jobId` and sends it with `POST /deploy/authenticated` or `POST /relay`. After admission, the API returns `202 { "jobId": "0x…" }` without waiting for the transaction. Submission work continues if the client disconnects; browser execution/proving is separate and stops if its page closes. Retrying an identical submission with the same ID joins that job; different content with the same ID is `409 JOB_CONFLICT`.

`POST /recover/status` with `{ "jobId": "0x…" }` returns HTTP 200 with one of:

- `{ "status": "running" }` (deployment or relay, with reconciliation metadata when applicable).
- `{ "status": "succeeded", "result": { "address": "0x…", "identity": "0x…", "transaction_hash": "0x…" } }` after the deployment or recovery transaction is accepted successfully.
- `{ "status": "failed", "error": "CODE", "httpStatus": 502 }` (the status number reflects the failure; it is not always 502). Only the code is retained, not upstream error text.

The ID is a bearer capability: generate it with a cryptographic RNG, send it only in POST bodies, and never log or put it in a URL. The status endpoint never accepts an account as a lookup key and needs no login token. Recovery responses use `Cache-Control: no-store`. Polling has its own `poll` rate bucket, default 120 attempts per client / 6000 globally per minute, so polling does not consume submission limits. `kamui_recovery_jobs_total` records accepted, succeeded, failed and capacity-refused jobs without identifiers.

The job store is bounded to 32 active jobs and 1000 retained jobs total. Terminal jobs expire after 30 minutes and are pruned on access. Deployment token authentication happens before a job takes a slot. Relay shape/profile checks precede admission; chain/message checks happen inside the job before a paid send. Per-account locks apply across both operations. Full job storage answers `503 RECOVERY_JOBS_FULL`. Unknown or expired jobs answer `404 RECOVERY_JOB_NOT_FOUND`.

**Single-process durable metadata.** The API supports PostgreSQL for the lean hosted target (`STORAGE_BACKEND=postgres`, `DATABASE_URL`) and retains SQLite for local compatibility (`RECOVERY_DB`, default `recovery.sqlite` beside `REGISTRY_DB`). PostgreSQL startup takes an exclusive writer lease shared with the migration/operator tools; loss of that lease exits the API. Database failure never switches storage engines. See [POSTGRESQL.md](POSTGRESQL.md) for migration, local setup and restore restrictions. It stores a hash of the polling capability and no JWT, pepper, signature, proof or signed transaction. Before broadcasting, it journals the signed transaction's deterministic hash, sender and nonce. A restart checks accepted receipts for that hash; pre-confirmed receipts keep the lock. An interrupted pre-broadcast job needs a fresh sign-in/proof because its inputs are not saved. Browser proving never resumes from this database. Uncertain submissions remain locked and are never automatically re-sent. See [RECOVERY-JOBS.md](RECOVERY-JOBS.md) for the operator runbook, finalized replacement resolution and remaining limits. Run exactly one API process, stop it before operator resolution, and persist the database volume. The SDK never automatically resubmits after polling begins.

This protocol replaces the old synchronous response; deploy the backend and SDK/keychain together.

## Durable hosted funding

PostgreSQL mode now uses [FUNDING.md](FUNDING.md): global/operation/app/account count and fee limits, separate deployment/recovery budgets, conservative pre-send debits and a persisted pause. New databases start paused and the example policy is all zero. Approved app servers need a private credential distinct from the public app identifier. The hosted keychain's own wallet-management sponsorship remains off pending a dedicated owner-authenticated funding route; no credential is embedded in public pages.

Hosted runtime supports `SECRET_SOURCE=files` for scoped signing-key mounts, `DATABASE_URL_FILE` and optional `PAYMASTER_API_KEY_FILE`; values and files cannot be configured ambiguously. The restore gate blocks startup, POST admission and paid sends when missing/blocked, and guards JWK rotator writes. [Lean package](../../infra/aws/lean/README.md), [backup/restore](../../infra/aws/lean/backup/README.md).

## Sponsorship and budgets

`POST /sponsor` takes `{ account, calldata }` as before. A budget (`src/services/sponsor/budgets.ts`) has a number of transactions per period, a share of them one account may use, and the most the relayer pays for one transaction.

- The `x-kamui-app-key` header selects an app's budget. Without the header the request uses the shared `anonymous` budget. An unknown key is refused (`403 UNKNOWN_APP_KEY`); it does not fall back to anonymous.
- Budgets come from the JSON file named by `SPONSOR_BUDGETS_FILE`; `sponsor-budgets.example.json` shows the shape. Without a file there is only the anonymous budget: `SPONSORED_PER_HOUR` an hour, 120 by default on testnets and off on mainnet. A budget that names no fee ceiling gets 1 STRK.
- **An app key says who is billed. It is not a secret and protects nobody.** It ships in the app's front end; anyone can copy it and spend that app's budget, up to its limits. Users are protected by the account, which checks the owner or session signature on every sponsored call. Rotate a key by editing the file and restarting.
- Order of work (audit finding #4): attempt limits, parse, class check, reserve a slot in the budget, estimate the fee, refuse above the ceiling (`402 FEE_ABOVE_CEILING`), send with the bounds that were just checked. The slot counts only once the transaction was submitted; every other outcome gives it back. A submitted transaction that later reverts on chain still counts: the relayer paid for it.
- The accounting is the `SponsorLedger` interface, in process today. `reserve` must be atomic in a shared implementation.

### Optional AVNU service

Set `PAYMASTER_URL` (and optionally the server-side `PAYMASTER_API_KEY`) to send the existing signed SNIP-9 payload to a separate unmodified AVNU service. Empty keeps the development relayer. See [PAYMASTER.md](PAYMASTER.md) and `compose.paymaster.yml` for the operator setup, tests and remaining live checks. No AVNU code is linked into Kamui.

In AVNU mode the app fee ceiling is a **local preflight check only**: SNIP-29 does not carry our relayer's signed resource bounds, and AVNU uses a different relayer and estimate. External fee and total spending controls need operator/security review before production. AVNU mode is Sepolia-only until that review and a live run pass. Ambiguous external submissions keep their budget debit and are never retried or sent through the development relayer as a fallback.

## The session registry

The account contract cannot list its sessions, so the keychain records them here to show and revoke them. It is a convenience, not an authority: what a session may do is decided by the chain, and a reader must check each entry against the account.

Every request, including a read, is signed by an owner key over `poseidon('kamui.registry.v2', chainId, account, action, timestamp, nonce, subject, content)` and checked with the account's `is_valid_signature`. `content` is a hash of the whole record for a `put` and 0 otherwise, so a record cannot be changed after it is signed. `nonce` is a random felt, and each signed message is accepted once (`401 REPLAYED`); used messages are kept in the registry's database for the 300 s their timestamp stays valid. Exactly two signature elements are accepted (a session key signs with four), the timestamp must be within 300 s of the server's clock, and the account must be of the Kamui class. The SDK's `sdk/src/registry.ts` is the client.

- Storage uses the selected PostgreSQL backend, or SQLite for local compatibility (`REGISTRY_DB`, default `data/registry.sqlite`, gitignored). At most 50 live entries per account (`409 REGISTRY_FULL`; replacing an entry always works). Expired entries are dropped on every read or write of their account and hourly.
- The journal mode is explicit: `DELETE` by default. Do not use `WAL` on a network volume, and run exactly one api process against a file on one.
- The file says which sites each account connected to. Keep it private. The api logs nothing from the registry that names an account, an origin or a key.

## Rotator and watcher

**Rotator** (audit finding #2). For each issuer key it reads what the registry stores (`get_key`) and compares the key material limb by limb. Events are used only to list the key ids to look at. A missing key is set, a retired one removed, and a key id whose material changed is removed and set again in one transaction. That replacement is a revocation: it cancels every recovery proof in flight and every pending override, for all users, so it happens only when the stored limbs differ and is logged at error level (`key_material_changed`). A node error while reading stops the sync; it is never read as "no key".

**Watcher** (plan decision D8). `bun run service:watcher` keeps watching; `bun run watch:once` makes one pass and exits 0 (all keys in effect verified), 1 (an alert) or 2 (something could not be checked). For each `KeySet` event it fetches the issuer's keys itself, recomputes the modulus hash as `registry.cairo` does, and alerts when the hash differs, the issuer does not publish the key id, or the issuer is unknown. An alert is an error-level log line (`registry_key_alert`) and, when `WATCHER_WEBHOOK_URL` is set, a JSON POST. The rules for historical writes are at the top of `src/services/watcher/key-watcher.ts`.

The watcher holds no key and shares no state with the rotator, only the arithmetic in `src/jwk/modulus.ts`. Run it apart from the rotator, under another identity. The registry on Sepolia today is an older class whose `KeySet` carries no hash; for those writes the watcher hashes the key it reads from the registry's storage.

## Logs and metrics

Logs are one JSON object per line: `{ ts, level, event, ... }` (`src/log.ts`).

- Never logged: tokens, peppers, keys, signatures, proofs, user ids, request bodies, client addresses, origins, app keys, free-form error text (an RPC error quotes the request and the node URL). A failure is logged as a route, a status and an error code.
- **Account addresses are logged** on `/recover`, `/relay`, `/deploy` and `/sponsor`, next to the transaction hash. They are public on chain beside that same transaction, and a stuck recovery cannot be traced without them. They are never logged with a client address, and never by the registry routes, where the request itself (this account uses the keychain, now) is the private part.
- Metrics (`src/metrics.ts`): requests by route and outcome, rate-limit refusals, proofs by result with duration and queue depth, sponsor decisions by budget, failures of the issuer, pepper service, prover and RPC, relayer transactions by kind, registry requests. Labels come from fixed sets and budget names only.
- `/metrics` is served on `METRICS_PORT` (9464), not on the public port. Do not publish that port. With `METRICS_TOKEN` set it is also on the public port behind a bearer token.

## Keys

The relayer and registry-owner keys are read through `SecretSource` (`src/secrets.ts`). The only implementation reads the environment. A managed secret store plugs in by implementing the interface and returning it from `secretSource`; a signer that never releases the key plugs in as a starknet.js `SignerInterface`. Both are described in that file. Neither is built.

## Run

Use the pinned Bun 1.4.4 binary described in the repository handoff. Docker is optional for the backend services; it is not needed for proving.

```sh
bun install
cp .env.example .env.local   # fill in the secrets; deployments.env (committed) holds public addresses only
bun run service:api
bun run service:rotator
bun run service:watcher
```

`deployments.env` points at upstream's registry and prover executor on Sepolia and at the Kamui class declared there on 2026-11-12. The browser RPC must serve the fixed-block state/proofs required by the Wasm executor; see `../../spikes/s1/README.md`.

Set `CHAIN_ID` (for example `SN_SEPOLIA`) to let the api, rotator and watcher start while the RPC is down; they then check the node's chain in the background and stop if it differs.

The scripts under `src/scripts/` build the contracts with `scarb`. Put the pinned version first on `PATH` as described in `../../contracts/README.md`.

## Test

```sh
bun test
```

Backend regression tests use fakes for the chain, the issuers, the prover, the paymaster and the relayer. Recovery tests cover disconnected clients, idempotent submissions, bounded retention, polling retries and sanitized failures. Regression tests for the audit findings: `src/services/rotator/sync.test.ts` (#2), `src/jwk/jwks-cache.test.ts` and `src/services/recovery/recover.test.ts` (#3), `src/services/recovery/sponsor.test.ts` and `src/services/api/app.test.ts` (#4). The pepper and registry tests use the SDK's own client code, so both sides of each protocol are checked together.

## PostgreSQL migration

The selected lean target runs PostgreSQL on the backend server, with pepper in its separate AWS account. [POSTGRESQL.md](POSTGRESQL.md) covers local setup and explicit stopped-API cutover. It does not provision EC2, change the current developer databases or implement cloud backups. SQLite remains available for existing local tests; PostgreSQL has explicit opt-in integration tests using a disposable `KAMUI_TEST_POSTGRES_URL`.

## Not done

- **Live runs.** This code ran on Sepolia on 2026-11-12 (`../../spikes/s1/results/RESULTS.md`, run 8): a deployment with the pepper confirmed, two proofs, sponsored session and owner calls, the session registry, and a recovery sign-in to an existing account without the pepper check. The rotator set the new registry's keys. Not exercised live: the budgets' refusals, the fee ceiling, the registry's replay refusal and the watcher against the new registry.
- **Google-only live run 10:** revoke-all, removal of a stale device and recovery-file sign-in with pepper stopped passed on Sepolia; see `../../spikes/s1/results/run-10-device-session-recovery.md`.
- **One api process is assumed.** The HTTP attempt limiter and issuer cache remain in process. PostgreSQL job locks and funding counters are durable, but one relayer key still means one nonce; the enforced writer lease does not make this a multi-replica service or fence an already-prepared Starknet send.
- **Recovery jobs and AVNU ran live** on Sepolia on 2026-11-12 (run 9): recovery after a dropped submission response, AVNU owner/session calls, scope/replay refusals and a budget refusal after a lost success response. No mainnet claim follows from this.
- **Recovery metadata is durable; proof work is not.** Results and transaction intents survive restart on a retained database volume. Interrupted proving needs a fresh sign-in, unknown transaction intents stay locked, and reloading a keychain page does not resume polling. PostgreSQL paid-attempt count/fee budgets survive restarts; generic HTTP rate limits remain in memory. SQLite development retains its historical memory ledger.
- **The registry's replay check is per database.** It is enforced in the selected database, including PostgreSQL and explicit SQLite imports. Restoring stale history requires the external host fence and conservative reconciliation.
- **Budgets:** PostgreSQL now enforces both counts and worst-case fee totals per period; no per-app usage UI is implemented. AVNU actual fees remain external to signed local bounds. Funding policy thresholds/app approval and the keychain wallet-management funding route still need review.
- **Keys:** hosted processes support scoped private file mounts, while development may use environment values. Neither is a non-extractable Stark-curve signer; host compromise, custody and role isolation need security review.
- **Client-side V2 acceptance.** The pinned Wasm integration passed an existing-account Google recovery on Sepolia in run 11. Hosted-origin, first-deployment, broader browser/resource and cloud restore acceptance remain pending. See [CLIENT_PROVING.md](../../keychain/CLIENT_PROVING.md) for browser/resources/assets and remaining acceptance.
- **Override recovery with a pepper** has not been exercised.
