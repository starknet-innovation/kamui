# Host reboot and reopening backend writes

What happens when a Sepolia host reboots, and the one operator command that reopens paid backend writes afterwards: `setup/14-reopen-after-reboot.sh`. It runs from the workstation over SSM `AWS-RunShellScript` (the same pinned-document, one-intent-per-send `Driver.command` as `09`/`10`). It changes **no file in the installed host package**: the host-side program is [`reopen_host.py`](reopen_host.py), sent inline and run with `python3 -I`, and it only calls the installed wrappers (`host.py`, `wallet-control.py`) and `systemctl`.

## What a reboot does today

- **Pepper** has no gate. `kamui@pepper.service` is installed but not enabled, so the pepper stack stays down after a reboot until started.
- **Backend**: `kamui@backend.service` Requires `kamui-backend-boot-fence.service` (drop-in `restore-fence.conf`). That fence runs once per OS boot (`RemainAfterExit`), **blocks the restore gate** (`/var/lib/kamui/restore-gate/state.json`, reason `restore`, new generation) and writes `/run/kamui/boot-fenced` with the boot id. `host.py backend up` refuses without that marker.
- The API **exits at startup** while the gate is blocked (`services/backend/src/services/api/index.ts`), and every backend service uses `restart: "no"`. So a backend stack started under a blocked gate does not serve 503s: `host.py up --wait` fails, the unit is `failed`, PostgreSQL/keychain/Caddy/watcher may be left running and the API is down.
- Reopening needs a `restored`-mode acknowledgement of the **current** generation, at least ten minutes after it was blocked (`RESTORE_REPLAY_WAIT_MS`), with the API/rotator stopped.

`apiAndRotatorStopped` is **enforced**, not only attested: `wallet-control.py` refuses while any `api`/`rotator` container is not exited/dead/created, and `restore-control.ts acknowledge` holds the exclusive PostgreSQL writer lease. The other four attestations cannot be checked by a machine.

## Enabling start at boot

Decision: **enable the pepper stack and the backend boot fence, not the backend stack.**

| Unit | At boot | Why |
|---|---|---|
| `kamui@pepper.service` | `systemctl enable` | Stateless HMAC service with no gate; it starts after `kamui-imds-guard@pepper` and `kamui-secrets@pepper` (which fetches runtime files with the instance role after `network-online.target`). |
| `kamui-backend-boot-fence.service` | `systemctl add-wants multi-user.target` (it has no `[Install]` section) | Blocks the gate at boot, so the ten-minute replay window has normally elapsed when the operator reacts. Starts nothing that signs. |
| `kamui@backend.service` | **leave disabled** | Enabling it is fail-closed (the fence is ordered first and the API exits under a blocked gate), but it leaves a `failed` unit with a half-running stack: Caddy and keychain serve the site while the API is down. Nothing is gained, because the backend must wait for the operator anyway. `reopen` starts the stack once the gate is acknowledged. |

`reopen` also copes with an enabled backend stack (failed unit, API exited), so this is a cleanliness choice, not a safety one.

Apply with the tooling (one SSM command per host; idempotent; takes effect on the next boot; reboots nothing):

```sh
cd infra/aws/lean/setup
./14-reopen-after-reboot.sh enable-boot
```

Or by hand through Session Manager:

```sh
# pepper host
sudo systemctl enable kamui@pepper.service
systemctl is-enabled kamui@pepper.service          # enabled
# backend host
sudo systemctl add-wants multi-user.target kamui-backend-boot-fence.service
ls -l /etc/systemd/system/multi-user.target.wants/kamui-backend-boot-fence.service
systemctl is-enabled kamui@backend.service         # stays disabled
```

Undo: `systemctl disable kamui@pepper.service`, and on the backend `rm /etc/systemd/system/multi-user.target.wants/kamui-backend-boot-fence.service && systemctl daemon-reload`. The host installer refuses to install over an *enabled* unit; a future reviewed upgrade disables these first.

## After a reboot

From `infra/aws/lean/setup`, with the usual authenticated profiles and `~/.kamui-hosting-sepolia`:

```sh
./14-reopen-after-reboot.sh status                       # read-only, both hosts
./14-reopen-after-reboot.sh fence                        # only if status shows fence "missing"
./14-reopen-after-reboot.sh reopen --review-ref <ref>    # interactive; you are attesting
```

`fence` is needed only when the backend fence did not run this boot (boot start not enabled yet). It starts `kamui-backend-boot-fence.service` once, which begins the replay window.

### What `reopen` checks before acknowledging

On the workstation, from a fresh read-only inspection, and then **again on the host** inside the mutating command:

1. The host has not rebooted since the inspection (same boot id).
2. `/run/kamui/boot-fenced` holds the current boot id, and `kamui-backend-boot-fence.service` is **active**. If the fence unit were inactive, `systemctl start kamui@backend` would run it again, reblock the gate and undo the acknowledgement.
3. The gate is `blocked`, reason `restore`, was blocked **during this boot** (`changedAt` ≥ kernel boot time), and its generation is the one the operator confirmed.
4. The replay window has elapsed: 600 s plus a 30 s clock margin, measured on the host clock. The workstation **waits** for it (after your confirmation), re-inspecting after each wait; the host refuses if it has not elapsed.
5. API and rotator are stopped. An active `kamui@backend.service` is first stopped through its reviewed `ExecStop`. A writer running outside the unit is refused, not killed.
6. PostgreSQL is started alone (`host.py backend prepare`), then `recovery_jobs` is read in a read-only transaction: **any** row with `finished_at IS NULL` refuses. The counts reported are unfinished, those with a retained transaction intent (sent, outcome unknown), and those reconciling. Rows only become terminal when the API reconciles them, so a refusal here needs the manual restored-data procedure in [backup/README.md](../backup/README.md).

Then it writes `/etc/kamui/operator/reboot-ack-<generation>.json`, runs `wallet-control.py restore acknowledge` (which re-checks stopped writers, takes the database writer lease and re-checks the replay window itself), confirms the gate is `ready`/`restored` for that generation and review reference, runs `systemctl start kamui@backend.service`, and confirms the unit is active, every backend service is healthy and the gate was not reblocked.

### What it attests on your behalf

Before anything changes it prints the list and requires you to type `REOPEN` at a terminal (no terminal: it refuses). The acknowledgement then records:

| Field | Basis |
|---|---|
| `apiAndRotatorStopped` | Checked and enforced (see above). |
| `originalWriterCannotRestart` | **Your attestation**: no other host, clone, supervisor or old deployment can start a signer. |
| `signerHistoryReconciled` | **Your attestation**: relayer/signer history and nonces match trusted chain evidence. A reboot does not lose PostgreSQL commits, but the command cannot verify chain state. |
| `uncertainIntentsRetained` | **Your attestation**, backed by the unfinished-recovery-job refusal. |
| `replayAndBudgetsConservative` | **Your attestation**; replay timing is backed by the enforced window. |

`--review-ref` is your private reconciliation reference. It is stored in the gate (`reviewRef`), so it must match `^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$` and must not contain personal data. **Never schedule or script `reopen`.** Running it is the attestation.

Restore acknowledgement does not clear a durable spending pause. Pepper health is reported. An unhealthy pepper prints a warning but does not stop the backend reopen.

### Output, evidence and retries

The terminal shows fixed labels, states and counts. Gate generation, boot id, your confirmation and every host result are written to `~/.kamui-hosting-sepolia/installation/reboot/` (mode `0600`); SSM request/response logs go to `installation/aws-private/` and `installation/operations/` as for `09`/`10`. The command takes the same installation lock as `07`–`13`.

Every subcommand observes the host again on each run. A send whose result is uncertain is reconciled by its comment and never resent. The host programs are idempotent. If the stack start fails after the acknowledgement, rerunning `reopen` with the same `--review-ref` skips the acknowledgement and only starts the stack. An already-open backend is left untouched. A different review reference for an already-acknowledged generation is refused.

Exit status is `0` on success and `1` with one fixed code otherwise. Common codes:

| Code | Meaning |
|---|---|
| `REOPEN_BOOT_FENCE_MISSING_RUN_FENCE_FIRST` | This boot was never fenced: run `fence`, then `reopen` (it waits the window). |
| `REOPEN_BOOT_FENCE_UNIT_NOT_ACTIVE` | Marker present but the fence unit is not active. Investigate; starting the stack would reblock. |
| `REOPEN_GATE_NOT_FROM_THIS_BOOT` / `REOPEN_GATE_REASON_NOT_RESTORE` | The gate was not blocked by this boot's fence (fresh setup or a restore). Use the backup/restore procedure. |
| `REOPEN_RECOVERY_JOBS_UNFINISHED` | Unfinished or uncertain recovery jobs: counts are printed, nothing was acknowledged. |
| `REOPEN_WRITERS_RUNNING_OUTSIDE_STACK_UNIT` | An API/rotator container runs without the unit. Investigate, do not kill blindly. |
| `REOPEN_ACKNOWLEDGEMENT_REFUSED_<code>` | `wallet-control.py` refused (for example `HOST_CONTROL_BUSY`, `RESTORE_GATE_BUSY`). |
| `REOPEN_STACK_START_FAILED` / `REOPEN_STACK_NOT_HEALTHY_AFTER_START` | Gate is acknowledged; fix the cause, rerun `reopen` with the same reference. |
| `REOPEN_HOST_STATE_CHANGED_DURING_WAIT` / `REOPEN_HOST_REBOOTED_SINCE_INSPECTION` | Start again from `status`. |
| `REOPEN_NOT_CONFIRMED` / `REOPEN_INTERACTIVE_CONFIRMATION_REQUIRED` | Nothing mutating was sent. |

## Validation

`python3 -B -m unittest discover -s infra/aws/lean/install -p 'test_*.py'` includes `test_reopen.py`. It covers fake hosts that model systemd, the boot fence, Compose status, PostgreSQL counts and `wallet-control` acknowledgement, plus a fake SSM driver, the generated shell body (`sh -n` plus an unprivileged run) and a Python 3.9 syntax check of the host program. It has **not** been run against a real host, systemd or AWS, and no host was rebooted.
