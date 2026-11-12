#!/usr/bin/env bash
# Disposable POSIX repository, separate Docker volumes, synthetic data only. No AWS.
set -euo pipefail
umask 077
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(cd -- "$here/../../../.." && pwd)
image=${KAMUI_DRILL_IMAGE:-kamui-pgbackrest-drill:local}
operator_image=${KAMUI_DRILL_OPERATOR_IMAGE:-kamui-backend-operator-drill:local}
prefix="kamui-drill-$(date +%s)-$$"
source_container="$prefix-source"
restored_container="$prefix-restored"
repository="$prefix-repo"
source_data="$prefix-source-data"
restore_data="$prefix-restore-data"
work=$(mktemp -d "${TMPDIR:-/tmp}/kamui-backup-drill.XXXXXXXX")
work=$(cd -- "$work" && pwd -P)
restore_target="$work/postgres-restore-data"
canonical_data="$work/postgres"
cleanup() {
  docker rm -f "$source_container" "$restored_container" >/dev/null 2>&1 || true
  docker volume rm "$repository" "$source_data" "$restore_data" >/dev/null 2>&1 || true
  docker network rm "${prefix}_default" >/dev/null 2>&1 || true
  # Restored PostgreSQL files belong to the container UID. Return only this
  # disposable bind directory to the invoking user before removing the temp tree.
  for directory in "$restore_target" "$canonical_data"; do
    if [[ -d $directory ]]; then
      docker run --rm --user root --mount "type=bind,source=$directory,target=/cleanup" "$image" \
        chown -R "$(id -u):$(id -g)" /cleanup >/dev/null 2>&1 || true
    fi
  done
  rm -rf -- "$work"
}
trap cleanup EXIT INT TERM
python3 "$here/test_restore.py" >"$work/host-lock.log" 2>&1 || { cat "$work/host-lock.log" >&2; exit 1; }
fail() { printf '{"status":"failed","error":"%s"}\n' "$1" >&2; exit 1; }
# Reuse an explicit image or build the local-only development image.
if ! docker image inspect "$image" >/dev/null 2>&1; then
  docker build -t "$image" "$here" >"$work/build.log" 2>&1 || fail DRILL_BUILD_FAILED
fi
# Build from an explicit allowlist; never send developer secrets as build context.
mkdir -p "$work/operator-context"
cp "$root/services/backend/package.json" "$root/services/backend/bun.lock" "$root/services/backend/deployments.env" "$work/operator-context/"
cp "$root/services/backend/src/services/api/Dockerfile" "$work/operator-context/Dockerfile"
cp -R "$root/services/backend/src" "$work/operator-context/src"
docker build -t "$operator_image" "$work/operator-context" >"$work/operator-build.log" 2>&1 || fail DRILL_OPERATOR_BUILD_FAILED
mkdir -m 0777 "$restore_target"
cat >"$work/pgbackrest.conf" <<'CONF'
[global]
repo1-type=posix
repo1-path=/repo
repo1-retention-full=2
archive-check=y
archive-async=n
start-fast=y
process-max=1
log-level-console=warn
log-level-file=off
lock-path=/tmp/pgbackrest
[kamui]
pg1-path=/var/lib/postgresql/data
pg1-user=postgres
CONF
chmod 0644 "$work/pgbackrest.conf"
for volume in "$repository" "$source_data"; do
  docker volume create "$volume" >/dev/null
  docker run --rm --user root --mount "type=volume,source=$volume,target=/target" "$image" chown postgres:postgres /target >/dev/null
 done
common=(--mount "type=bind,source=$work/pgbackrest.conf,target=/etc/pgbackrest/pgbackrest.conf,readonly" --mount "type=volume,source=$repository,target=/repo")
docker run -d --name "$source_container" "${common[@]}" --mount "type=volume,source=$source_data,target=/var/lib/postgresql/data" \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=kamui "$image" \
  postgres -c archive_mode=on -c "archive_command=pgbackrest --stanza=kamui archive-push %p" -c archive_timeout=60 >"$work/source-id"
wait_ready() {
  local container=$1
  for _ in $(seq 1 150); do
    # pg_isready also succeeds on the entrypoint's temporary initialization
    # server. Wait for the final PID1 postmaster and the actual application DB.
    if docker exec "$container" sh -c 'test "$(head -n 1 /var/lib/postgresql/data/postmaster.pid)" = 1' >/dev/null 2>&1 \
      && docker exec "$container" psql -X -At -U postgres -d kamui -c 'SELECT 1' >/dev/null 2>&1; then return; fi
    sleep .2
  done
  fail DRILL_DATABASE_NOT_READY
}
wait_ready "$source_container"
psql_source() { docker exec "$source_container" psql -X -v ON_ERROR_STOP=1 -U postgres -d kamui "$@"; }
psql_source -c "CREATE TABLE recovery_jobs (id text PRIMARY KEY, intent text); CREATE TABLE registry_used_messages (message text PRIMARY KEY, expires bigint); CREATE TABLE funding_control (key text PRIMARY KEY, paused boolean NOT NULL); CREATE TABLE funding_debits (id text PRIMARY KEY, kind text NOT NULL, account text NOT NULL, app text, fee numeric(80,0) NOT NULL, created_at bigint NOT NULL, external boolean NOT NULL); INSERT INTO recovery_jobs VALUES ('fixture-capability-hash', 'fixture-uncertain-intent'); INSERT INTO registry_used_messages VALUES ('fixture-replay-hash', 9999999999); INSERT INTO funding_control VALUES ('global', false); INSERT INTO funding_debits VALUES ('fixture-before', 'recovery', '0x1', NULL, 100, 1000, false);" >"$work/fixture.log" 2>&1 || fail DRILL_FIXTURE_FAILED
docker exec -u postgres "$source_container" pgbackrest --stanza=kamui stanza-create >"$work/stanza.log" 2>&1 || fail DRILL_STANZA_FAILED
docker exec -u postgres "$source_container" pgbackrest --stanza=kamui --type=full backup >"$work/backup.log" 2>&1 || fail DRILL_BACKUP_FAILED
# This row is deliberately AFTER the full backup; recovering it proves WAL replay.
psql_source -c "INSERT INTO registry_used_messages VALUES ('fixture-after-backup', 9999999999); UPDATE funding_control SET paused=true WHERE key='global'; INSERT INTO funding_debits VALUES ('fixture-after', 'sponsor', '0x1', 'fixture-app-hash', 200, 2000, true); SELECT pg_switch_wal();" >"$work/wal.log" 2>&1
docker exec -u postgres "$source_container" pgbackrest --stanza=kamui check >"$work/check.log" 2>&1 || fail DRILL_ARCHIVE_CHECK_FAILED
docker stop "$source_container" >/dev/null
cat >"$work/compose.yml" <<COMPOSE
name: $prefix
services:
  postgres:
    image: $image
    user: postgres
    volumes:
      - $work/pgbackrest.conf:/etc/pgbackrest/pgbackrest.conf:ro
      - $repository:/repo
      - $restore_target:/var/lib/postgresql/data
  operator:
    image: $operator_image
    user: '0:0'
    environment:
      RESTORE_GATE_FILE: /run/kamui/restore-gate/state.json
    volumes:
      - $work/restore-gate:/run/kamui/restore-gate
volumes:
  $repository:
    external: true
COMPOSE
: >"$work/release.env"
# A nonempty replacement must be refused, and admission must already be blocked.
touch "$restore_target/must-not-overwrite"
if STATE_DIRECTORY="$work" KAMUI_BACKUP_REVIEWED=yes KAMUI_COMPOSE_FILE="$work/compose.yml" KAMUI_ENV_FILE="$work/release.env" \
  KAMUI_BACKUP_LOG_DIR="$work/private-logs" KAMUI_POSTGRES_RESTORE_ROOT="$work" POSTGRES_DATA_DIRECTORY="$restore_target" \
  "$here/restore.sh" --writers-stopped >"$work/refused.log" 2>&1; then fail DRILL_NONEMPTY_TARGET_ACCEPTED; fi
grep -q RESTORE_TARGET_NOT_EMPTY "$work/refused.log" || fail DRILL_WRONG_REFUSAL
[[ -f $restore_target/must-not-overwrite ]] || fail DRILL_TARGET_CHANGED
# Test owns this one sentinel; production restore never removes old data.
rm -- "$restore_target/must-not-overwrite"
STATE_DIRECTORY="$work" KAMUI_BACKUP_REVIEWED=yes KAMUI_COMPOSE_FILE="$work/compose.yml" KAMUI_ENV_FILE="$work/release.env" \
  KAMUI_BACKUP_LOG_DIR="$work/private-logs" KAMUI_POSTGRES_RESTORE_ROOT="$work" POSTGRES_DATA_DIRECTORY="$restore_target" \
  "$here/restore.sh" --writers-stopped >"$work/restore.log" 2>&1 || fail DRILL_RESTORE_WRAPPER_FAILED
# Promotion uses the fixed runtime path, retaining a previous canonical directory.
# The local test may run unprivileged; production operator tools run as root.
docker run --rm --user root --mount "type=bind,source=$restore_target,target=/fixture" "$image" chown -R "$(id -u):$(id -g)" /fixture >/dev/null
mkdir "$canonical_data"
printf 'old fixture data\n' >"$canonical_data/old-data-retained"
mkdir "$work/unrelated"
printf '16\n' >"$work/unrelated/PG_VERSION"
if STATE_DIRECTORY="$work" KAMUI_BACKUP_REVIEWED=yes KAMUI_COMPOSE_FILE="$work/compose.yml" KAMUI_ENV_FILE="$work/release.env" POSTGRES_DATA_DIRECTORY="$work/unrelated" \
  "$here/promote.sh" --writers-stopped >"$work/wrong-promotion.log" 2>&1; then fail DRILL_WRONG_PROMOTION_ACCEPTED; fi
grep -q PROMOTE_RESTORE_TARGET_INVALID "$work/wrong-promotion.log" || fail DRILL_WRONG_PROMOTION_REFUSAL
[[ -f $canonical_data/old-data-retained && -f $restore_target/PG_VERSION ]] || fail DRILL_PROMOTION_CHANGED_OLD_DATA
STATE_DIRECTORY="$work" KAMUI_BACKUP_REVIEWED=yes KAMUI_COMPOSE_FILE="$work/compose.yml" KAMUI_ENV_FILE="$work/release.env" POSTGRES_DATA_DIRECTORY="$restore_target" \
  "$here/promote.sh" --writers-stopped >"$work/promote.log" 2>&1 || fail DRILL_PROMOTION_FAILED
[[ -f $canonical_data/PG_VERSION && ! -e $restore_target ]] || fail DRILL_CANONICAL_PROMOTION_FAILED
previous=$(find "$work" -maxdepth 1 -type d -name 'postgres-before-restore-*' -print)
[[ -n $previous && -f $previous/old-data-retained ]] || fail DRILL_OLD_DATA_NOT_RETAINED
docker run -d --name "$restored_container" "${common[@]}" --mount "type=bind,source=$canonical_data,target=/var/lib/postgresql/data" \
  "$image" postgres -c archive_mode=off >"$work/restored-id"
wait_ready "$restored_container"
counts=$(docker exec "$restored_container" psql -X -At -v ON_ERROR_STOP=1 -U postgres -d kamui -c "SELECT (SELECT COUNT(*) FROM recovery_jobs WHERE intent='fixture-uncertain-intent')::text || ':' || (SELECT COUNT(*) FROM registry_used_messages)::text || ':' || (SELECT COUNT(*) FROM funding_debits)::text || ':' || (SELECT paused::text FROM funding_control WHERE key='global');")
[[ $counts == 1:2:2:true ]] || fail DRILL_RESTORED_DATA_MISMATCH
# API admission must still refuse despite a healthy restored database.
RESTORE_GATE_FILE="$work/restore-gate/state.json" "${BUN:-bun}" -e "import { assertRestoreReady } from '$root/services/backend/src/storage/restore-fence.ts'; let blocked=false; try { assertRestoreReady(process.env); } catch(e) { blocked=(e as Error).message==='RESTORE_RECONCILIATION_REQUIRED'; } if(!blocked) process.exit(1);" >"$work/admission.log" 2>&1 || fail DRILL_ADMISSION_NOT_FENCED
version=$(docker exec "$restored_container" psql -X -At -U postgres -d kamui -c 'SHOW server_version;')
backup_version=$(docker exec "$restored_container" pgbackrest version)
printf '{"status":"passed","postgres":"%s","backup":"%s","hostControlLockVerified":true,"canonicalPromotionVerified":true,"wrongPromotionTargetRefused":true,"previousDataRetained":true,"restoreWrapperVerified":true,"nonemptyTargetRefused":true,"baseBackupRestored":true,"postBackupWalReplayed":true,"uncertainIntentRetained":true,"replayRowsRetained":2,"fundingDebitsRetained":2,"spendingPauseRetained":true,"admission":"blocked","awsAccess":false}\n' "$version" "$backup_version"
