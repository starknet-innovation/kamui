# Kamui backend

The services behind a login: the recover API, the prover it calls, the rotator that keeps the on-chain key registry in step with Google and Apple, and the watcher that checks the rotator's work. The api also sponsors transactions and keeps the session registry.

It started as upstream's backend (keep-starknet-strange/social-account, MIT). The Kamui changes are listed in `THIRD_PARTY.md`. It has had one audit pass (findings #2, #3 and #4 are fixed here) and is not production-ready: see "Not done".

## What it does

| Part | What it does |
|---|---|
| `POST /recover` | Verifies the login token, confirms the pepper with the pepper service, deploys the account if needed, has the prover prove `prove_jwt`, and submits `recover` from the relayer. This is the path the SDK's `completeLogin` uses. |
| `POST /relay` | Submits `recover` with a proof the browser made. The token never reaches this backend. |
| `POST /deploy` | Relayer-paid deployment for browser proving. Disabled when a pepper service is configured, because there is no token to confirm a pepper with. |
| `POST /sponsor` | The relayer pays for an `execute_from_outside_v2` call on a Kamui account, out of a budget. The paymaster stand-in. |
| `POST /registry/sessions`, `/list`, `/remove` | The session registry: which sessions an account approved, and for which site. |
| `GET /health/api`, `/health/prover`, `/health/rotator`, `/live` | Health. `/live` depends on nothing. |
| `GET /metrics` | Prometheus text, on its own port (9464). |
| Prover | The SNIP-36 prover, in Docker. One proof at a time; see the memory note in `compose.yml`. |
| Rotator | Copies the issuers' current signing keys into the on-chain registry. |
| Watcher | Checks every key written to the registry against the issuer's published keys, and alerts. |

Errors are a non-2xx status with `{ "error": "CODE" }`.

## The pepper

When `PEPPER_SERVICE_URL` is set and a request would deploy a new account, `/recover` first asks the pepper service for the pepper of the request's token, using the key proof the client sends (`keyProof`), and refuses unless it equals the pepper the client sent. Nothing is deployed or proven before that.

- **Only before a deployment.** An account that already exists is not confirmed with the pepper service: its address was derived from that very pepper, and `prove_jwt` checks the identity again on chain. This is what lets a user sign in from a recovery file when the pepper service is unavailable or lost.
- On mainnet the service is mandatory and pepper 0 is always refused, for new and existing accounts. The api does not start on mainnet without `PEPPER_SERVICE_URL`.
- On a testnet without the service, any pepper is accepted, including 0.
- If the pepper service is down, a request that needs a deployment answers 502. It never falls back to accepting the pepper.

Why: the client picks the pepper it sends, and the pepper decides which account address gets deployed. Without the check, anyone holding a valid token could make the relayer deploy accounts for made-up peppers.

## What one request can cost

Every POST route goes through the same wrapper (`src/services/api/app.ts`):

1. **Rate limits**, before the body is read: attempts per minute per client, then for everyone. Defaults: recover 6 / 60, relay 10 / 120, deploy 6 / 60, sponsor 30 / 600, registry 60 / 1200 (`RATE_LIMITS`). A refusal is `429 RATE_LIMITED`. These bound attempts; the hourly caps and budgets behind them bound spending.
2. **The handler**, which checks everything it can from the request alone before calling anything.
3. **Deadlines** on every outbound call: issuer keys 5 s, pepper service 10 s, each RPC request 30 s (`RPC_TIMEOUT_MS`), a proof 10 min (`PROVER_TIMEOUT_MS`), health probes 3 s.

The limiter is one interface (`src/limiter.ts`) with an in-process implementation. With more than one api process, implement it over a shared store.

**The client** is the socket's peer unless `TRUSTED_PROXY_HOPS` says how many of our own proxies are in front; then it is that many entries from the right of `X-Forwarded-For`. The keychain's `/api` proxy and any load balancer must append the address they saw, or every user shares one bucket.

### `/recover` (audit finding #3)

- The token's issuer, audience, expiry and nonce are checked first, with no outbound call.
- The issuer's keys come from a cache (`JwksCache`): fetched at most once per 5 minutes per issuer, concurrent misses share one fetch, and a token naming a key id that is not in the cache forces a refresh at most once a minute. So a rotated key works within a minute of the first token signed with it, five minutes at worst. An issuer that does not answer is `502 JWKS_UNAVAILABLE` after 5 s, and is not asked again for 10 s. Expired keys are never used.
- The prover runs `PROVER_CONCURRENCY` (1) proofs; `PROVER_QUEUE_MAX` (4) more wait, for at most `PROVER_QUEUE_WAIT_MS` (5 min). Beyond that the answer is `503 PROVER_BUSY`, and it is given before any deployment is paid for. One recovery per account runs at a time (`409 IN_PROGRESS`).

## Sponsorship and budgets

`POST /sponsor` takes `{ account, calldata }` as before. A budget (`src/services/sponsor/budgets.ts`) has a number of transactions per period, a share of them one account may use, and the most the relayer pays for one transaction.

- The `x-kamui-app-key` header selects an app's budget. Without the header the request uses the shared `anonymous` budget. An unknown key is refused (`403 UNKNOWN_APP_KEY`); it does not fall back to anonymous.
- Budgets come from the JSON file named by `SPONSOR_BUDGETS_FILE`; `sponsor-budgets.example.json` shows the shape. Without a file there is only the anonymous budget: `SPONSORED_PER_HOUR` an hour, 120 by default on testnets and off on mainnet. A budget that names no fee ceiling gets 1 STRK.
- **An app key says who is billed. It is not a secret and protects nobody.** It ships in the app's front end; anyone can copy it and spend that app's budget, up to its limits. Users are protected by the account, which checks the owner or session signature on every sponsored call. Rotate a key by editing the file and restarting.
- Order of work (audit finding #4): attempt limits, parse, class check, reserve a slot in the budget, estimate the fee, refuse above the ceiling (`402 FEE_ABOVE_CEILING`), send with the bounds that were just checked. The slot counts only once the transaction was submitted; every other outcome gives it back. A submitted transaction that later reverts on chain still counts: the relayer paid for it.
- The accounting is the `SponsorLedger` interface, in process today. `reserve` must be atomic in a shared implementation.

## The session registry

The account contract cannot list its sessions, so the keychain records them here to show and revoke them. It is a convenience, not an authority: what a session may do is decided by the chain, and a reader must check each entry against the account.

Every request, including a read, is signed by an owner key over `poseidon('kamui.registry.v2', chainId, account, action, timestamp, nonce, subject, content)` and checked with the account's `is_valid_signature`. `content` is a hash of the whole record for a `put` and 0 otherwise, so a record cannot be changed after it is signed. `nonce` is a random felt, and each signed message is accepted once (`401 REPLAYED`); used messages are kept in the registry's database for the 300 s their timestamp stays valid. Exactly two signature elements are accepted (a session key signs with four), the timestamp must be within 300 s of the server's clock, and the account must be of the Kamui class. The SDK's `sdk/src/registry.ts` is the client.

- Storage is SQLite (`REGISTRY_DB`, default `data/registry.sqlite`, gitignored). At most 50 live entries per account (`409 REGISTRY_FULL`; replacing an entry always works). Expired entries are dropped on every read or write of their account and hourly.
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

The relayer, prover-account and registry-owner keys are read through `SecretSource` (`src/secrets.ts`). The only implementation reads the environment. A managed secret store plugs in by implementing the interface and returning it from `secretSource`; a signer that never releases the key plugs in as a starknet.js `SignerInterface`. Both are described in that file. Neither is built.

## Run

Bun 1.2 or later, and Docker for the prover.

```sh
bun install
cp .env.example .env.local   # fill in the secrets; deployments.env (committed) holds public addresses only
bun run service:prover       # Docker; needs about 20 GB for the VM, see compose.yml
bun run service:api
bun run service:rotator
bun run service:watcher
```

`deployments.env` points at upstream's registry and prover executor on Sepolia and at the Kamui class declared there on 2026-11-12. The RPC must serve storage proofs for about 100 blocks back; see `../../spikes/s1/README.md`.

Set `CHAIN_ID` (for example `SN_SEPOLIA`) to let the api, rotator and watcher start while the RPC is down; they then check the node's chain in the background and stop if it differs.

The scripts under `src/scripts/` build the contracts with `scarb`. Put the pinned version first on `PATH` as described in `../../contracts/README.md`.

## Test

```sh
bun test
```

118 tests in 12 files, all with fakes for the chain, the issuers, the prover and the relayer. Regression tests for the audit findings: `src/services/rotator/sync.test.ts` (#2), `src/jwk/jwks-cache.test.ts` and `src/services/recovery/recover.test.ts` (#3), `src/services/recovery/sponsor.test.ts` and `src/services/api/app.test.ts` (#4). The pepper and registry tests use the SDK's own client code, so both sides of each protocol are checked together.

## Not done

- **Live runs.** The code before these changes ran on Sepolia on 2026-11-12 (`../../spikes/s1/results/RESULTS.md`, run 5). Since then only the watcher has run against Sepolia (one read-only pass: 5 keys verified). The new api, the budgets, the registry and the reworked rotator have run only against fakes.
- **One api process is assumed.** The limiter, the sponsor ledger, the proof queue, the per-account locks and the issuer key cache are in process, and one relayer key means one nonce: a second api process needs shared implementations of the first two and nonce coordination (or its own relayer account).
- **A long proof outlives the connection.** Bun closes an idle connection after 255 s at most; a proof can take longer. `/recover` should become a job the client polls.
- **The registry's replay check is per database.** It holds with one api process on one file, which is what is assumed above.
- **Budgets** count transactions, not fees. There is a ceiling per transaction but no fee total per period, and no usage report per app.
- **Keys** are still read from the environment.
- **The prover** image is `:latest`, has no plain HTTP health route (the api's `/health/prover` sends it a JSON-RPC ping), and its real memory need is somewhere between 8 and 19.5 GB per proof.
- **Override recovery with a pepper** has not been exercised.
