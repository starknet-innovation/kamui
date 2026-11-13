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
  from this boot, at most an hour old, written for exactly the installed release, and on the backend
  naming the generation of the blocked gate. The installer consumes the record, so it cannot
  authorise a second upgrade. Nothing may be running except the backend's one-shot boot fence.
  Units may stay enabled.

## Steps

From `infra/aws/lean/setup` on a clean checkout of the source you are releasing:

| Step | What happens | Downtime |
|---|---|---|
| `11-supersede-unstarted-release.sh`, `07`, `08`, `13` | Build the new release locally, as for any release. `13` only if runtime files changed. | none |
| `15-upgrade-started-release.sh prepare` | Asks you to type `UPGRADE`. Pepper: stops its stack. Backend: refuses if a recovery job is unfinished; stops the backup timers and the stack; starts PostgreSQL alone; full backup and check; blocks the gate; stops PostgreSQL; records the preparation. | starts |
| `15-upgrade-started-release.sh install` | `09` in upgrade mode on both hosts: new package and images. Run within an hour of `prepare`. | |
| `10-verify-installation.sh` | Verifies both hosts. | |
| `15-upgrade-started-release.sh finish` | Starts the pepper stack. Reports that the backend awaits reopening. | pepper back |
| `14-reopen-after-reboot.sh reopen --review-ref <ref>` | Backend writes reopen on your attestation, as after a reboot. | backend back |
| `15-upgrade-started-release.sh finish` | Restarts the backup timers that were running before. | |

Expect at least 10 minutes with backend writes closed, plus the image pull.

## If something stops halfway

- **`prepare` refused before the backup:** nothing changed except, possibly, stopped backup timers
  (listed as `BACKUP_TIMERS_LEFT_STOPPED`). If the stack was stopped, `14 reopen` starts it again; the
  gate is still open.
- **`prepare` refused after blocking the gate:** the stack is down and writes are closed. Fix the
  cause and rerun `prepare`, or abandon the upgrade with `14 reopen` (the old release is still
  installed).
- **`install` refused:** the old release is still installed; the refusal code says why (for example
  `UPGRADE_PREPARATION_STALE_RUN_15_PREPARE_AGAIN`). Rerun `prepare`, then `install`.
- **The new release does not start:** the database may already carry the new release's schema. Roll
  back by upgrading again to the previous source revision with this same procedure, and if the
  schema is incompatible, restore the backup `prepare` reported (see `backup/README.md`, "Restore
  after data loss or stale backup").

PostgreSQL itself refuses to open a data directory from another major version, and the release
build pins `postgres:16`, so an image upgrade cannot silently corrupt the database.
