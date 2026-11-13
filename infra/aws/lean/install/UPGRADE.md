# Upgrading a started wallet

Once the wallet has started, the host installer refuses any new release. `--replace-unstarted`
only replaces a release that never ran. This procedure is the reviewed way to ship a new release to
hosts that hold real data. It is tested offline only until its first live run.

## What it guarantees

- **A rollback point.** The backend takes a fresh full pgBackRest backup, with writers stopped,
  immediately before anything is replaced, and checks it.
- **No writes until you reopen them.** The restore gate is blocked before the install and stays
  blocked until `14 reopen`, on your attestation, after the 10-minute replay window.
- **State untouched.** The installer replaces the package, units and image list; it never touches
  `/var/lib/kamui` (database, restore gate, Caddy certificates) or `/etc/kamui` (secrets).
- **Only a prepared host.** `--upgrade-started` is accepted only with the record `15 prepare` leaves:
  carrying the id of this run's preparation, from this boot, at most an hour old, written for exactly
  the installed release, and on the backend naming the generation of the still-blocked gate. The
  installer consumes the record, so it cannot authorise a second upgrade. Nothing may be running
  except the backend's one-shot boot fence and the read-only monitor timers. Units may stay enabled.
- **No lifecycle command in between.** `prepare` holds the host lifecycle lock (the one `host.py` and
  `wallet-control.py` take) from its writer check, through the backup and the gate block, until the
  record is written. The installer holds it from validating the record until the replacement is
  done. A concurrent `host.py up` or gate change is refused with `HOST_CONTROL_BUSY`. Release 5 and
  earlier cannot inherit the lock, so on the first upgrade away from them it is handed over for
  each of their own `host.py` / `wallet-control.py` calls only and retaken at once (refusing if
  anyone else took it). `wallet-control` itself refuses to block the gate while a writer runs.
- **Backup timers come back as they were.** Before stopping anything, `prepare` records which backup
  timers were running, adding to an earlier record if a previous attempt refused. `finish` starts
  exactly those, whether or not they are enabled, and forgets the record.

## Steps

From `infra/aws/lean/setup` on a clean checkout of the source you are releasing:

| Step | What happens | Downtime |
|---|---|---|
| `11-supersede-unstarted-release.sh`, `07`, `08`, `13` | Build the new release locally, as for any release. `13` only if runtime files changed. | none |
| `15-upgrade-started-release.sh prepare` | Asks you to type `UPGRADE`. Backend first: refuses if a recovery job is unfinished or a backup is running; stops the backup timers and the stack; starts PostgreSQL alone; full backup and check; blocks the gate; stops PostgreSQL; records the preparation under a new id. Then pepper: stops its stack and records its own id. | starts |
| `15-upgrade-started-release.sh install` | For each host, backend then pepper: the package install (`09` in upgrade mode), then the image pull as a separate command. Run within an hour of `prepare`. | |
| `10-verify-installation.sh` | Verifies both hosts. | |
| `15-upgrade-started-release.sh finish` | Starts the pepper stack. Reports that the backend awaits reopening. | pepper back |
| `14-reopen-after-reboot.sh reopen --review-ref <ref>` | Backend writes reopen on your attestation, as after a reboot. | backend back |
| `15-upgrade-started-release.sh finish` | Restarts the backup timers that were running before. | |

Expect at least 10 minutes with backend writes closed, plus the image pull. The host may take up to
two hours for `prepare` (a full backup can take up to an hour); the workstation waits that long.

## If something stops halfway

`prepare` runs the backend first; if the backend refuses, pepper has not been touched.

- **`prepare` refused before blocking the gate** (a backup was already running, the backup or its
  check failed, no fresh backup was found): the gate is still open. Possibly stopped are the backup
  timers (listed as `BACKUP_TIMERS_LEFT_STOPPED`) and the backend stack. `15 finish` starts the
  stack again, restarts those timers and starts pepper. Then retry `prepare` when the cause is fixed.
- **`prepare` refused after blocking the gate:** the stack is down and writes are closed. Fix the
  cause and rerun `prepare`, or abandon the upgrade with `14 reopen` then `15 finish` (the old
  release is still installed).
- **`install` stopped:** it works host by host (backend package, backend images, pepper package,
  pepper images), so the hosts can end up on different releases. Before deciding anything:
  1. If the code is `INSTALL_COMMAND_UNCERTAIN_RECONCILE_ONLY` or `INSTALL_COMMAND_PENDING_RECONCILE_SAME_STEP`,
     a command may still be running. Rerun `15 install` to observe it; it never resends one whose
     outcome is unknown. Do nothing else until it reports a final result.
  2. Run `10-verify-installation.sh`. It checks backend then pepper and stops at the first host
     that does not carry the new package and its images. The receipt
     `/var/lib/kamui-install/<role>.json` on each host names its installed manifest.
  3. Then:
     - **An image pull failed** (the package is installed): rerun `15 install`. The package
       installs only reconcile, and the failed pull is sent again after checking the installed
       package. No new `prepare` is needed.
     - **A package install was refused:** every check that can refuse runs before that host changes
       anything visible, so that host still has the old release. The code says why (for example
       `UPGRADE_PREPARATION_STALE_RUN_15_PREPARE_AGAIN`, or `INSTALLED_FILE_CHANGED_REFUSE_REPLACE`
       for a unit edited on the host). Each preparation authorises one install per host: rerun
       `prepare`, then `install`. A host already on the new release reports it as installed.
     - **Abandoning:** only if `10` shows both hosts still on the old release, `14 reopen` then
       `15 finish`. If either host already has the new package, finishing would start the new
       release; to go back, upgrade again to the previous source revision with this procedure.
- **The new release does not start:** the database may already carry the new release's schema.
  Keep writes closed. Upgrading again to the previous source revision restores the old code, not the
  old schema. `backup/restore.sh` is **not** a schema rollback: it restores the latest backup and
  replays all archived WAL, including any migration the new release ran. Returning to the backup
  `prepare` reported (a point-in-time restore to that label) needs a separately reviewed recovery
  plan before any reopen. That plan must cover funding, replay and on-chain reconciliation as in
  `backup/README.md`, "Restore after data loss or stale backup".

PostgreSQL itself refuses to open a data directory from another major version, and the release
build pins `postgres:16`, so an image upgrade cannot silently corrupt the database.
