# PostgreSQL storage and SQLite cutover

The lean Sepolia design runs PostgreSQL on the backend server, with pepper in its separate AWS account. This document covers application storage and an offline cutover; it does not provision EC2, change AWS permissions, implement cloud backups or authorize deployment. Production operation, keys, database privileges and restore procedures still need their respective reviewers.

## Runtime configuration

Set `STORAGE_BACKEND=postgres` and configure `DATABASE_URL` privately in the backend's runtime configuration. A PostgreSQL URL also selects PostgreSQL when `STORAGE_BACKEND` is absent. Do not put credentials in shell history, command arguments, Git, screenshots or chat. Do not create a file named `.env`; local development uses the existing ignored `.env.local`. Do not print that file. Unset `REGISTRY_DB` and `RECOVERY_DB` in PostgreSQL mode; ambiguous mixed configuration is refused rather than silently opening SQLite.

The database listener belongs on a local interface/private service network. Do not publish PostgreSQL to the internet or expose its credentials to the keychain/browser. Run the application as a separate database role, with privileges scoped to this database. Database credentials, TLS/local socket policy and bootstrap-versus-runtime privileges need operator review; this migration does not create users or permissions.

Schema initialization is versioned and transactional. Registry sessions/replay hashes and recovery metadata are separate tables in one database. Recovery storage binds the database to the configured Starknet chain ID and account class. Journal JSON is stored as text so intent compare-and-swap and migrated fingerprints remain byte-exact.

Exactly one API or operator writer is allowed. PostgreSQL mode holds an advisory lock on the same sole database connection that performs all reads/writes. The connection pool closes terminally on connection loss rather than reconnecting without its lease. Another API/operator command fails rather than sharing the same relayer. Loss of the serving API's writer lease is fatal. Startup requires `fsync=on` and `full_page_writes=on`; the connection uses `synchronous_commit=on`. These checks do not prove physical storage durability. This does not coordinate an independent rotator or another service using the same Starknet signer: signer separation/nonce ownership still require review. Do not run multiple API replicas merely because PostgreSQL supports concurrent clients. The database lease is not a distributed fence for an already-prepared Starknet RPC send: a process may lose its SQL connection after the intent commit. Stop and confirm exit of the old API before starting a replacement, including after lease failure. Account journal locks do not solve shared relayer nonce ownership across different accounts.

PostgreSQL funding now persists global/operation/app/account count and fee debits plus operator pause; see [FUNDING.md](FUNDING.md). New databases start paused and policies default to zero. Approved app servers authenticate separately from public app identifiers. The public keychain's own wallet-management funding remains disabled until a dedicated owner-authenticated route is reviewed. The host restore gate guards startup, POSTs and paid sends; see the [backup runbook](../../infra/aws/lean/backup/README.md).

## Local database

`compose.postgres.yml` starts only a local PostgreSQL service, bound to `127.0.0.1:55432`, with a persistent Docker volume. Set `POSTGRES_PASSWORD` privately in `.env.local`, then run from `services/backend`:

```sh
docker compose --env-file .env.local -f compose.postgres.yml up -d
```

Configure `DATABASE_URL` privately for database/user `kamui` on that local port, using the same password. Use URL encoding for credential characters; do not paste the URL in a command. This local Compose file does not start the API or add backups. The development `postgres:16` image tag needs a reviewed digest for hosting.

## Offline SQLite-to-PostgreSQL cutover

1. Stop API admission and **stop the old API**, including automatic supervisors and rollout replacements. Wait for the process to exit. Retain its deployment/configuration version and private copies of both SQLite databases, including any SQLite WAL files required for a consistent backup. Do not copy a live database file and assume it is a complete backup.
2. Prepare a fresh, empty PostgreSQL database privately. Confirm the intended chain and account class. Preserve the old databases in their original location until cutover is accepted; the migration opens them read-only and does not checkpoint, prune or rewrite them.
3. Configure `DATABASE_URL`, `CHAIN_ID` (for example `SN_SEPOLIA`) and `KAMUI_ACCOUNT_CLASS_HASH` privately. The script also loads the repository's public deployment defaults. It never needs a signing key, pepper, proof or JWT. Run from `services/backend`, using the current Bun binary:

   ```sh
   /Users/adrienlacombe/ws/kamui/spikes/s1/tools/node_modules/.bin/bun run src/scripts/migrate-postgres.ts --api-stopped <registry-sqlite-path> <recovery-sqlite-path>
   ```

   The `--api-stopped` flag records the operator's prerequisite; it cannot discover or stop SQLite writers. PostgreSQL fencing also cannot stop a writer still using the old SQLite files. On another machine use its installed current Bun binary instead of this workstation path.
4. A successful command prints only row counts. It verifies exact imported rows inside the target transaction, including session insertion IDs/order, expired replay rows, finished results, unresolved intents, capability hashes, fingerprints and network binding. It preserves the original SQLite autoincrement high-water mark. No pruning happens during import. Unexpected source schema or recovery metadata keys, malformed state, missing/different network binding or a populated target causes refusal. An import marker prevents a repeated import even if application rows are later removed.
5. Start one API with PostgreSQL configuration and the same chain/class. Verify health, signed registry reads, replay rejection, retained polling capabilities and ordinary receipt reconciliation. Verify that unfinished jobs with unavailable or pre-confirmed receipts remain locked. Existing jobs without a paid intent are interrupted rather than recreated with secret inputs.
6. Keep admission paused if verification fails. Preserve both data copies. Do not immediately restart the old SQLite API after the PostgreSQL API has accepted work: its journal/replay/budget history is now stale. Stop the API and reconcile before any rollback or another cutover. Never clear active rows to force a retry.

The target import is one PostgreSQL transaction. Schema bootstrap may remain after a refused import, but imported rows and the success marker roll back together. Error output uses fixed codes and does not include raw SQL, database URLs, source paths or row contents. Source files are not deleted. There is no merge, force-overwrite or automatic fallback option. Operators must resolve incompatible source versions explicitly, not drop fields or guess a binding.

## Backup and restore requirements

Local PostgreSQL survives ordinary API/container restarts only if its data volume is retained. Server/disk loss needs private off-host backups. Recommend PostgreSQL base backups plus continuous WAL archiving, failure/lag alerts and a restore drill. Logical dumps alone do not retain the database's continuous transaction history for point-in-time recovery. Retention, recovery-point/recovery-time objectives, storage sizing and the backup implementation remain pending. [PostgreSQL backup and recovery](https://www.postgresql.org/docs/current/continuous-archiving.html)

A stale backup can omit a paid send, consumed registry nonce or funding debit. **Keep admission, relaying, sponsorship and rotator writes stopped after restoring stale data.** Independently reconcile signer history and account state, retain uncertain locks and reconstruct conservative replay/budget state before resuming. If completeness cannot be established, stay paused for operator resolution. Absence of a transaction row is not proof that no transaction was broadcast.

## Local integration checks

Integration tests run only when `KAMUI_TEST_POSTGRES_URL` is explicitly set to a disposable local PostgreSQL instance. The migration suite creates and drops its own temporary database; the configured test user therefore needs local test-only `CREATEDB` privileges. Never point this variable at a shared, hosted or production database. No real signing keys or JWTs are used.

The suite checks exact import, unchanged SQLite files, original identity sequence, imported replay rejection and uncertain-intent reconciliation through the live PostgreSQL stores, unsupported metadata refusal, refusal of nonempty/repeated targets, network mismatch, malformed JSON, transaction rollback on verification failure, API writer exclusion and redacted CLI errors. Other PostgreSQL suites exercise live store concurrency and recovery lifecycle behavior. This is local database evidence, not AWS deployment, power-loss durability or cloud backup validation.

## Validation — migration step, 12 November 2026

With the bundled Bun 1.4.4 and a disposable local PostgreSQL 16 container, the complete backend suite passed: **188 tests, zero failures**. Backend TypeScript (`tsc --noEmit`), local Compose configuration validation and `git diff --check` passed. Tests exercise both the existing SQLite implementation and explicit PostgreSQL paths. At that migration step no signing transaction, existing-database cutover, EC2 deployment, physical power-loss trial or backup restore drill was run. The later lean backup package adds a disposable local base-backup/WAL restore drill; see its evidence/runbook. No AWS/S3 validation follows from that local drill. The disposable test database was removed after validation.
