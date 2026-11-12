# Third-party code

## keep-starknet-strange/social-account (MIT)

This folder started as a copy of `backend/` from
https://github.com/keep-starknet-strange/social-account at commit
`e1681348afbf5fc55ea410ea7ef93e1df575e969`. Licence: MIT, Copyright (c) 2026 Keep Starknet
Strange; the text is in `licenses/social-account-LICENSE`.

Unchanged from upstream: `src/social-account.ts`, `src/services/prover/Dockerfile`, the
generated fixtures and the tests that came with the code.

Changed for Kamui (each change is marked `Kamui:` in the code):

- `src/services/recovery/pepper.ts` and its test are new: the pepper is confirmed with the
  pepper service before anything is paid for.
- `src/services/recovery/recover.ts`: calls that check; the request carries `keyProof`.
- `src/services/recovery/relay.ts`: reads the account's owners anchor (`get_owners_anchor`)
  where upstream read its single key (`get_public_key`).
- `src/services/recovery/deploy.ts`: `/deploy` is disabled when a pepper service is configured.
- `src/services/api/index.ts`: pepper settings, health output. The routes moved to `app.ts`
  (new), which adds rate limits, error mapping, metrics and the new routes; `index.ts` only
  reads settings and serves.
- `src/http.ts`: upstream's in-process `allow` limiter is gone; `src/limiter.ts` (new) replaces it.
- `src/env.ts`: loads `deployments.env`; RPC requests have a deadline; `resolveChain` lets a
  service start without the RPC when `CHAIN_ID` is set.
- `src/jwk/verification.ts`: `fetchJwks` has a deadline and checks the answer's shape;
  `JwksCache` is new (audit finding #3).
- `src/jwk/modulus.ts` is new. It holds the limb and event code that was in the rotator, plus
  the modulus hash and the storage read, shared with the watcher.
- `src/services/rotator/jwk-rotator.ts`: compares key material read from the registry's storage
  instead of key ids (audit finding #2); structured logs; `/live`; the owner key comes from the
  secret source.
- `src/services/prover/prove.ts`: the proof deadline is a parameter; a non-JSON answer is a
  `ProverError`. `src/services/prover/queue.ts` is new.
- `src/services/recovery/recover.ts`: request checks before any outbound call, cached issuer
  keys, the proof queue, one recovery per account at a time, structured logs.
- `src/services/recovery/relay.ts`, `deploy.ts`: the shared limiter and structured logs; the
  client address is no longer logged.
- `src/services/recovery/sponsor.ts` (Kamui's own) and `src/services/sponsor/budgets.ts` (new):
  per-app budgets (audit finding #4).
- New, with no upstream counterpart: `src/services/registry/` (session registry),
  `src/services/watcher/` (registry key watcher), `src/log.ts`, `src/metrics.ts`, `src/net.ts`,
  `src/secrets.ts`, and their tests.
- The api, rotator and watcher Dockerfiles use an exact Bun version and run as the `bun` user.
- `src/scripts/`: point at `contracts/` and the Kamui class; `declare-social-account.ts` is now
  `declare-account.ts`.
- `compose.yml`: the prover's memory cap is 20 GB instead of 8 GB.
- `deployments.env` replaces upstream's committed `.env` (this repository does not allow files named `.env`) and is loaded by `src/env.ts`. It holds the Kamui class hash; `SOCIAL_ACCOUNT_CLASS_HASH` is now `KAMUI_ACCOUNT_CLASS_HASH`.

Upstream states that this code is a proof of concept and not audited for production.

## Lean backup/runtime packaging

The optional lean PostgreSQL image installs unmodified pgBackRest from the base distribution, and the HTTPS package runs an unmodified Caddy image. Source, license/version references and review limitations are in `infra/aws/lean/backup/README.md` and `infra/aws/lean/README.md`. The local drill used PostgreSQL 16.15 and pgBackRest 2.60.0; hosted image digests/licenses must be reviewed and pinned. No third-party wallet implementation was consulted for this work.
