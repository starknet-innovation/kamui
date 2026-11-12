# Lean package local validation — 12 November 2026

Application baseline: committed PostgreSQL migration `0bc1910`, plus the lean follow-up in this change. This record covers local components and prepared operator artifacts. No AWS account/resource/security settings, DNS, Google settings, image registry publication or live Starknet transaction was changed.

| Check | Result | Practical scope |
|---|---|---|
| Backend Bun suite with explicit disposable PostgreSQL 16 | 215 passed, zero failures | SQLite compatibility, PostgreSQL stores/migration, funding/pause/auth, operator CLI, restore gate and startup-error privacy |
| Pepper Bun suite | 54 passed, zero failures | Existing service behavior and fixed-code startup failure |
| SDK documented five unit files | 96 passed, zero failures | Existing public SDK regression checks |
| Keychain Playwright matrix | 219 passed, 3 skipped | Bundled Chromium, Firefox and WebKit, mocked external services; no real Google/proving/cloud acceptance |
| Keychain server configuration/proxy checks | 6 passed | Public configuration, exact route/method restrictions and caller credential forwarding without injection/reflection |
| Demo app proxy test | 1 passed | Server-only credential scoped to sponsor, browser override ignored |
| Backend/keychain/pepper TypeScript | Passed | `tsc --noEmit` in each package |
| Host package Python tests | 7 passed | Digest/consumer/port boundaries, stopped-writer checks, host locking, boot fencing and canonical data selection |
| Backup Python tests | 4 passed | Shared-lock/state refusals and restore promotion/rollback/path safeguards |
| Lean shell syntax / diff whitespace | Passed | Bash parsing and `git diff --check` |
| Backend, pepper and production keychain Docker images | Built for linux/amd64 | Normalized public code permissions; no hosted image publication |
| Production keychain container smoke | Passed | Prebuilt JS, pinned assets, public config, metrics refusal and sanitized upstream failure |
| Both Caddy configurations | Adapt/validation and real failed-proxy privacy probes passed | Custom credential and OAuth-query sentinels absent from logs; no real TLS issuance |
| API/operator permission probe | Passed against disposable PostgreSQL | UID 1000 private API file, separate UID 0 operator file, fresh gate acknowledgement and initially paused funds |
| Container startup privacy | Passed | API/pepper emit fixed startup-failed events without raw configuration exceptions |
| Base backup + WAL + production restore/promotion wrappers | Passed | See [measured result](backup/local-restore-result.json): later replay rows, funding debits/pause and uncertain intent survive; old data retained; canonical path selected; admission stays blocked |

## Commands and interpretation

Use Bun 1.4.4 (`spikes/s1/tools/node_modules/.bin/bun` on this workstation). Backend integration tests require `KAMUI_TEST_POSTGRES_URL` explicitly pointing to a disposable local database; suites create isolated schemas/databases. Do not use a hosted/shared database. The final backend suite ran from `services/backend`, pepper from `services/pepper`, and SDK's five named files from `sdk`.

The browser command ran from `keychain` with `BUN` pointing to that binary and `KAMUI_TEST_BUNDLED_CHROMIUM=1`. These UI tests mock the chain, backend, pepper and issuers. WebKit is not a naturally elapsed Safari storage-expiry trial, and no full browser proof was generated in this matrix. Prior live recovery evidence remains separate in run 11.

Run package checks from the repository root:

```sh
python3 -m unittest discover -s infra/aws/lean/tests -p 'test_*.py'
python3 -m unittest discover -s infra/aws/lean/backup -p 'test_*.py'
```

The backup runbook gives the disposable Docker drill command. The production wrapper uses a local POSIX backup repository in that drill; S3/IMDS and a physical host failure were not exercised. Named temporary containers/volumes/networks are cleaned; local build images/caches remain available.

An initial repository-root `bun test` invocation was not the package harness: it collected browser-only specifications and package-relative fixture tests and failed. The documented package commands above passed. No claim is made that repository-root auto-discovery is a supported all-project test command.

## Release and review gates

The package is not permission to enable public fees or deploy. New funding is paused and the policy example is all zero. Review app credentials and exact caps, AVNU's external controls, privacy/retention, signer custody/nonce separation, AWS role/bucket/key permissions, backup retention/RPO/RTO and actual alert recipients. The keychain's own wallet-management sponsorship still needs a dedicated owner-authenticated route.

Actual Linux systemd reboot behavior, EC2/IMDS/KMS access, S3 authorization/encryption, DNS/Google callback, TLS issuance/renewal, host-loss recovery time, physical power-loss durability, memory/load sizing and public abuse/asset-egress resistance remain unverified. Current limits recommend 4 GiB for the backend until the smaller host is measured; the $100/month planning target is not an approved or enforced ceiling.
