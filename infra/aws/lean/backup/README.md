# PostgreSQL backups and fenced restore

Implementation prepared 12 November 2026. This package runs PostgreSQL 16 with pgBackRest, proposes a private S3 repository using the EC2 role, and keeps wallet admission blocked across restore. No AWS account, bucket, role, key policy, retention policy or timer was changed. AWS/security/operations reviewers must approve the actual placement, role, bucket, retention, image digest and incident procedure before hosting. No backup contains pepper HMAC key material; that key stays in KMS.

## Files and installation boundary

- `Dockerfile`: PostgreSQL 16 plus the distribution pgBackRest package. The local drill built pgBackRest 2.60.0; pin reviewed base/result image digests for hosting. pgBackRest's upstream license is [MIT](https://github.com/pgbackrest/pgbackrest/blob/main/LICENSE); retain installed package notices and review the complete image's licenses separately.
- `pgbackrest.conf.example`: S3 repository, temporary EC2 role credentials, TLS verification. Install the completed file privately as `/etc/kamui/backup/pgbackrest.conf`. No access keys are put in the file. PostgreSQL mounts it read-only at `/etc/pgbackrest/pgbackrest.conf`.
- `postgresql-backup.conf`: runs the pgBackRest archive command synchronously (transactions do not wait for S3 archival), enables durable PostgreSQL settings and a 60-second archive timeout during activity. The timeout is not a guaranteed recovery-point objective.
- `backup.sh`: stopped-policy-by-default host wrapper for stanza initialization, full/incremental backup and archive/age checks. Private diagnostics have directory mode 0700/file mode 0600; stdout contains fixed status codes. The operator must select diagnostic-log retention before timers are enabled.
- `restore.sh` / `restore.py`: holds the same host lifecycle `.operator.lock` as startup and offline controls, blocks the external host gate first, refuses running Compose services, requires an explicitly selected empty replacement data directory, restores without `--delta`/`--force`, and never clears admission.
- `promote.sh` / `promote.py`: under the same host lock with admission blocked and all services stopped, promotes the restored directory to the fixed `${STATE_DIRECTORY}/postgres` runtime path. Retains an existing canonical directory at a unique `postgres-before-restore-*` path; no deletion. If the second rename fails, it attempts to restore the previous canonical directory and keeps admission blocked regardless.
- `kamui-backup@.service` and timer examples: daily full backups and hourly WAL/backup-age checks. They are not enabled by this repository. Configure a real alert recipient/route, verify failed-unit delivery and approve scheduling before installation/enabling.
- `local-restore-drill.sh`: disposable local base-backup/WAL/restore verification with synthetic data; no S3 or AWS access.

The service package is installed at `/opt/kamui/lean`, with public release image references in `/etc/kamui/release.env`. Root-owned `operator.settings` can override `KAMUI_COMPOSE_FILE`, `KAMUI_ENV_FILE`, `CONFIG_DIRECTORY` and `STATE_DIRECTORY`; the examples match the lean package. Keep all image references digest-pinned and do not mix release versions during a restore.

## Operator preparation and first backup

Have the AWS owner provide a reviewed private repository bucket/prefix and a narrowly scoped EC2 role. Required operations include listing the approved prefix and reading/writing its objects; expiration also needs deletion. Review multipart and bucket-location calls against the tested pgBackRest release. Do not attach broad account access. Bucket ownership, public-access protection, TLS-only policy, encryption and deletion/recovery controls need AWS/security review. Default S3 server-side encryption protects new object data at rest; object metadata is a separate consideration. If SNF requires a separate KMS key or client-side encryption, revise and reprice the design rather than reusing the pepper key. [AWS SSE-S3 documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingServerSideEncryption.html)

The S3 template uses `repo1-s3-key-type=auto`; pgBackRest retrieves temporary role credentials. Container access to instance metadata/IMDSv2 must be reviewed and tested by the AWS owner. This local POSIX drill does not verify S3, the EC2 credential path, bucket policies or object encryption. [pgBackRest configuration](https://pgbackrest.org/configuration.html)

The proposed `repo1-retention-full-type=time` and value `7` retain a full-backup history covering at least seven days when sufficient backups exist; this is not seven objects or a strict seven-day deletion deadline. WAL needed by retained backups remains with them. **Seven days remains a proposal**, and `KAMUI_BACKUP_RETENTION_APPROVED` is empty by default. Do not set aggressive archive-expiration options or an S3 lifecycle that removes live pgBackRest objects. S3 versioning/Object Lock and organization-wide protection may add cost; have the owner assess them and price actual retained/WAL volume. The existing $20 lean usage allowance is not a measured backup quote. [pgBackRest retention semantics](https://pgbackrest.org/configuration.html)

After review, install the root-owned settings file, fill the explicit maximum successful-backup age and set both review acknowledgements to `yes`. An example 36-hour age threshold for daily full backups is 129600 seconds; it is not an approved recovery objective. With PostgreSQL alone running, use the reviewed settings environment to run:

```sh
/opt/kamui/lean/backup/backup.sh initialize
/opt/kamui/lean/backup/backup.sh full
/opt/kamui/lean/backup/backup.sh check
```

`check` verifies current WAL archival and repository access, then refuses a missing/stale latest successful backup. It does not prove every future restore, and a successful process exit does not mean an alert was delivered. Measure database/WAL growth and S3/request/egress costs before accepting the budget. Test archive outage, disk pressure and failed-unit alerts. Keep fees disabled until a real backup and disposable restore have passed against the reviewed repository.

## Scheduled backups and diagnostic-log retention

Diagnostic-log retention is **30 days** (operator decision, 13 November 2026). `backup.sh` writes one private `run.*` file per operation and one `info.*` file per `check` under `/var/log/kamui-backup` (directory 0700, files 0600, root). The hourly check alone creates about 48 files a day, so retention must be in place before the timers are enabled.

The release package does not install a retention rule. It is a host-level operator action. Install this root-owned file (mode 0644) as `/etc/tmpfiles.d/kamui-backup.conf`:

```
# Kamui backup diagnostic logs (backup.sh): private, root-only, 30-day retention.
# Operator decision 2026-11-13. Cleaned by systemd-tmpfiles-clean.timer.
d /var/log/kamui-backup 0700 root root 30d
```

The `d` line keeps the directory at 0700 root:root. The `30d` age lets the distribution's daily `systemd-tmpfiles-clean.timer` delete entries older than 30 days. systemd-tmpfiles measures age from the newest of atime, mtime and ctime, so reading a log file pushes its deletion back. It sits under `/etc`, outside `/etc/kamui`, so restarting the stack does not rewrite it. Verify it without deleting anything recent:

```sh
systemd-tmpfiles --cat-config | grep -n kamui-backup        # rule is loaded
systemd-tmpfiles --create /etc/tmpfiles.d/kamui-backup.conf  # mode/owner enforced
systemd-tmpfiles --clean  /etc/tmpfiles.d/kamui-backup.conf  # only removes entries older than 30d
systemctl is-active systemd-tmpfiles-clean.timer             # must be active
systemctl list-timers systemd-tmpfiles-clean.timer --no-pager
```

Enable the timers only after the first full backup and a passing `check`. The timers use the instances `kamui-backup@full.service` (daily 02:15 UTC, up to 5 minutes of random delay) and `kamui-backup@check.service` (hourly, up to 2 minutes of random delay):

```sh
systemctl daemon-reload
systemctl enable --now kamui-backup-full.timer kamui-backup-check.timer
systemctl start kamui-backup@check.service   # exercise the timer's unit once; fails if the check fails
```

Inspect them with:

```sh
systemctl list-timers 'kamui-backup*' --all --no-pager     # next and last runs
systemctl is-enabled kamui-backup-full.timer kamui-backup-check.timer
systemctl show kamui-backup@check.service -p Result -p ExecMainStatus
systemctl status kamui-backup@full.service --no-pager
journalctl -u kamui-backup@check.service -u kamui-backup@full.service --since -1d --no-pager -o cat
```

The journal shows only fixed status codes, for example `{"status":"backup-complete","operation":"check"}` or `{"status":"refused","error":"BACKUP_MISSING_OR_STALE"}`. Private pgBackRest output stays in `/var/log/kamui-backup`. A failed unit needs a reviewed alert route (`OnFailure=` or monitoring of failed units). The timers alone do not deliver alerts. To pause scheduling, run `systemctl disable --now kamui-backup-full.timer kamui-backup-check.timer`.

On the Sepolia beta backend, the retention rule was installed and both timers were enabled on 13 November 2026. A manual start of `kamui-backup@check.service` returned `Result=success`.

## Host admission gate

`RESTORE_GATE_FILE` points to `/run/kamui/restore-gate/state.json` inside API/rotator/operator containers. The corresponding host directory is `${STATE_DIRECTORY}/restore-gate`, **outside PGDATA**, mounted as a whole directory read-only in API/rotator and read-write only in the operator container. Do not bind-mount just `state.json`: atomic replacement would leave a single-file mount pinned to the old inode.

Missing, malformed, oversized, symlinked or blocked state refuses admission with `503 RESTORE_RECONCILIATION_REQUIRED`. The API checks startup, POST admission and immediately before paid sends; the rotator checks before submission. Writers must still be stopped because no file gate can recall an already-prepared Starknet RPC send. Gate control writes are fsynced and atomically renamed. A host-side `.restore-gate.lock` serializes generation changes; after an interrupted control command, removal of a stale lock requires confirming that no gate command remains active. Do not place this directory in a database backup or reset it by changing `STATE_DIRECTORY` during restore.

Fresh setup uses `restore-control.ts initialize`, which only creates a missing blocked gate. Prepare a private checklist from `fresh-ack.example.json`, replace its generation/review reference, and perform the checks before setting the attestations true. `acknowledge` takes the exclusive PostgreSQL writer lease and rejects a database with existing application tables in fresh mode. Run this before the first API schema bootstrap. A blocked restore gate cannot be acknowledged in fresh mode.

The operator container has the database URL secret and gate write access, but no wallet signing keys. With PostgreSQL running and API/rotator stopped, commands have this shape (using the configured reviewed release environment):

```sh
docker compose --env-file /etc/kamui/release.env -f /opt/kamui/lean/backend/compose.yml --profile operator run --rm --no-deps -T operator bun run src/scripts/restore-control.ts initialize
docker compose --env-file /etc/kamui/release.env -f /opt/kamui/lean/backend/compose.yml --profile operator run --rm --no-deps -T operator bun run src/scripts/restore-control.ts status
docker compose --env-file /etc/kamui/release.env -f /opt/kamui/lean/backend/compose.yml --profile operator run --rm --no-deps -T operator bun run src/scripts/restore-control.ts acknowledge /run/kamui/operator/restore-ack.json
```

Checklist files are mounted from `/etc/kamui/operator`, not passed inline or printed. They hold public operational references/attestations, not credentials, identities or proof material. An acknowledgement records an operator review; it is not cryptographic proof that on-chain history is complete.

## Restore after data loss or stale backup

1. Stop admission, then stop the backend supervisor and all API/rotator/signer processes; confirm they exited and cannot automatically restart. Retain the previous configuration and data. Stopping the SQL session alone is insufficient to fence a prepared transaction.
2. Keep the existing host `STATE_DIRECTORY` and restore gate. Prepare an empty replacement directory such as `/var/lib/kamui/postgres-restore-<operator-chosen-suffix>`, owned by the PostgreSQL container's reviewed UID. **Do not delete or overwrite the old data directory.** Set only `POSTGRES_DATA_DIRECTORY` to that new directory. The wrapper verifies an absolute canonical non-symlink path beneath the restore root and refuses nonempty targets.
3. Run `restore.sh --writers-stopped` with the reviewed settings and explicit replacement directory. It uses the operator service to block the gate before inspecting services/data; then it restores the latest backup/WAL into the empty target with archive mode disabled. No API is started and admission stays blocked. The `--writers-stopped` acknowledgement cannot discover a signer on another machine.
4. While every service remains stopped, run `promote.sh --writers-stopped` with the same restored `POSTGRES_DATA_DIRECTORY` selection. It blocks the gate again and verifies a stopped PostgreSQL 16 data directory beneath `STATE_DIRECTORY`, on the same filesystem. It preserves any old canonical data and renames the restored data into `${STATE_DIRECTORY}/postgres`. The previous directory is retained, not removed. If a rename or rollback fails, keep admission blocked and inspect both directories privately before continuing. Do not move mount points or change the gate/state root.
5. **Unset `POSTGRES_DATA_DIRECTORY` after promotion.** Normal host, boot, monitor and wallet-control tooling accepts only the fixed canonical runtime path; there is no ephemeral restore override to lose at restart. Start PostgreSQL **alone** through the normal canonical host `prepare` action. Verify restored rows, latest archived WAL, chain/class binding, funding debits/paused state, registry replay metadata and unresolved intents. Leave paid admission paused and do not start the rotator. Never release a recovery lock because a row or receipt is missing.
6. Reconcile signer transaction history/account state with trusted independent chain evidence. Account for paid sends/debits and unresolved intents after the backup's end; retain conservative locks and budgets. Wait at least ten minutes after blocking/stopping old writers with synchronized clocks so the registry's two five-minute timestamp-skew windows have elapsed. The CLI enforces a minimum ten minutes from the latest block timestamp, in addition to the operator's stopped-writer attestation. This waiting period does not reconcile paid sends or signer nonces.
7. If completeness cannot be established, stay blocked. If review succeeds, prepare the current-generation `restore-ack.example.json` attestations and acknowledge through the operator container while API/rotator remain stopped. Restore acknowledgement never clears the separate durable spending pause. Resume spending only after its own review and stopped-API control.
8. Restart exactly one API and the intended separate registry signer; verify receipt reconciliation, replay refusal, funding state, alerts and the approved release before reopening traffic. A rollback must retain the reconciled PostgreSQL history and current host gate; restarting an old SQLite snapshot is unsafe.

`restore.sh` holds the shared host lifecycle lock throughout the entire fence/status/restore operation. It checks every Compose service is in an explicitly stopped state; paused, restarting, removing and unknown states are refused. Direct Docker commands bypass the reviewed host wrappers and must not run concurrently. Supervisors, old hosts, alternate deployment projects and external nonce writers remain an operator responsibility. For a state root other than `/var/lib/kamui`, configure the reviewed `STATE_DIRECTORY` consistently. The replacement must be an empty `postgres-restore-*` child of that same root; a separate restore root is refused.

## Local evidence

Run from the repository with a current Bun binary:

```sh
BUN=/Users/adrienlacombe/ws/kamui/spikes/s1/tools/node_modules/.bin/bun infra/aws/lean/backup/local-restore-drill.sh
```

The drill uses separate synthetic source/repository/restore storage, creates a full base backup, writes replay and funding rows plus a spending pause **after** that backup, archives WAL, and restores to an independent directory and promotes it to the fixed canonical runtime path while retaining prior data. It checks the uncertain transaction intent, both replay rows, both funding debits and paused state, and verifies admission remains blocked. The drill invokes the actual production restore and promotion wrappers, verifies contention with the shared host lifecycle lock, verifies nonempty/wrong-target refusals, preserves previous data, and starts the restored PostgreSQL from the fixed canonical path with admission still blocked. All named drill containers, networks and volumes are cleaned on exit.

This is local component recovery evidence. It does not validate AWS permissions, S3 availability/encryption, host-loss recovery time, power-loss durability, automatic failover or security/production readiness. The latest successful measured result is in `local-restore-result.json`; refresh it after material PostgreSQL/pgBackRest/package changes.
