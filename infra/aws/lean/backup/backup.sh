#!/usr/bin/env bash
# Host-side wrapper. Must run only after operator review; no configuration is printed.
set -euo pipefail
umask 077
fail() { printf '{"status":"refused","error":"%s"}\n' "$1" >&2; exit 1; }
[[ ${KAMUI_BACKUP_REVIEWED:-} == yes ]] || fail BACKUP_REVIEW_REQUIRED
[[ ${KAMUI_BACKUP_RETENTION_APPROVED:-} == yes ]] || fail BACKUP_RETENTION_REVIEW_REQUIRED
state=${STATE_DIRECTORY:-/var/lib/kamui}
[[ ${POSTGRES_DATA_DIRECTORY:-$state/postgres} == "$state/postgres" ]] || fail NONCANONICAL_POSTGRES_DATA_DIRECTORY
export POSTGRES_DATA_DIRECTORY="$state/postgres"

compose=${KAMUI_COMPOSE_FILE:-/opt/kamui/lean/backend/compose.yml}
env_file=${KAMUI_ENV_FILE:-/etc/kamui/release.env}
[[ $compose = /* && $env_file = /* && -f $compose && -f $env_file ]] || fail BACKUP_CONFIG_REQUIRED
kind=${1:-}
case "$kind" in
  initialize) args=(stanza-create) ;;
  full) args=(--type=full backup) ;;
  incremental) args=(--type=incr backup) ;;
  check) args=(check) ;;
  *) fail BACKUP_USAGE ;;
esac
# Private diagnostics stay on the host; stdout/alerts expose only fixed codes.
log_dir=${KAMUI_BACKUP_LOG_DIR:-/var/log/kamui-backup}
[[ $log_dir = /* ]] || fail BACKUP_CONFIG_REQUIRED
install -d -m 0700 "$log_dir"
log_file=$(mktemp "$log_dir/run.XXXXXXXX")
if ! docker compose --env-file "$env_file" -f "$compose" exec -T -u postgres postgres \
  pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --stanza=kamui "${args[@]}" >"$log_file" 2>&1; then
  fail BACKUP_COMMAND_FAILED
fi
if [[ $kind == check ]]; then
  max_age=${KAMUI_BACKUP_MAX_AGE_SECONDS:-}
  [[ $max_age =~ ^[1-9][0-9]{0,7}$ ]] || fail BACKUP_AGE_POLICY_REQUIRED
  info_file=$(mktemp "$log_dir/info.XXXXXXXX")
  if ! docker compose --env-file "$env_file" -f "$compose" exec -T -u postgres postgres \
    pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --stanza=kamui --output=json info >"$info_file" 2>>"$log_file"; then
    fail BACKUP_COMMAND_FAILED
  fi
  if ! python3 - "$info_file" "$max_age" <<'PYTHON'
import json, sys, time
try:
    data = json.load(open(sys.argv[1]))
    stanza = next(x for x in data if x['name'] == 'kamui')
    if stanza.get('status', {}).get('code') != 0:
        raise ValueError()
    backups = stanza.get('backup', [])
    newest = max(x['timestamp']['stop'] for x in backups)
    if newest > time.time() + 300 or time.time() - newest > int(sys.argv[2]):
        raise ValueError()
except Exception:
    sys.exit(1)
PYTHON
  then fail BACKUP_MISSING_OR_STALE; fi
fi
printf '{"status":"backup-complete","operation":"%s"}\n' "$kind"
