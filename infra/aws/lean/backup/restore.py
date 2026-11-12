#!/usr/bin/env python3
"""Fenced, empty-target restore under the shared host lifecycle lock. No AWS calls."""
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('kamui_host', ROOT/'scripts/host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
STOPPED = {'exited', 'dead', 'created'}


def require_stopped(rows):
    if not isinstance(rows, list) or any(not isinstance(row, dict) or row.get('State') not in STOPPED for row in rows):
        raise ValueError('RESTORE_SERVICES_STILL_RUNNING')


def restore():
    if sys.argv[1:] != ['--writers-stopped']:
        raise ValueError('RESTORE_STOP_WRITERS_REQUIRED')
    if os.environ.get('KAMUI_BACKUP_REVIEWED') != 'yes':
        raise ValueError('BACKUP_REVIEW_REQUIRED')
    compose = Path(os.environ.get('KAMUI_COMPOSE_FILE', '/opt/kamui/lean/backend/compose.yml'))
    manifest = Path(os.environ.get('KAMUI_ENV_FILE', '/etc/kamui/release.env'))
    if not compose.is_absolute() or not manifest.is_absolute() or not compose.is_file() or not manifest.is_file():
        raise ValueError('RESTORE_CONFIG_REQUIRED')
    state = Path(os.environ.get('STATE_DIRECTORY', '/var/lib/kamui'))
    # The exact same host lock protects up/down, offline wallet controls and restore.
    # It stays held across the subprocesses; the operator CLI does not reacquire it.
    with host.control_lock(state):
        log_dir = Path(os.environ.get('KAMUI_BACKUP_LOG_DIR', '/var/log/kamui-backup'))
        if not log_dir.is_absolute() or log_dir.is_symlink():
            raise ValueError('RESTORE_CONFIG_REQUIRED')
        log_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        if log_dir.stat().st_uid != os.geteuid() or stat.S_IMODE(log_dir.stat().st_mode) & 0o077:
            raise ValueError('RESTORE_CONFIG_REQUIRED')
        descriptor, _ = tempfile.mkstemp(prefix='restore.', dir=log_dir)
        with os.fdopen(descriptor, 'wb') as diagnostics:
            command = ['docker', 'compose', '--env-file', str(manifest), '-f', str(compose)]
            # Block before data/status checks. Only the operator container gets gate write
            # access and its scoped DB secret; no signing keys are mounted there.
            block = command + ['--profile', 'operator', 'run', '--rm', '--no-deps', '-T', 'operator', 'bun', 'run', 'src/scripts/restore-control.ts', 'block']
            if subprocess.run(block, stdout=diagnostics, stderr=diagnostics).returncode:
                raise ValueError('RESTORE_FENCE_FAILED')
            checked = subprocess.run(command + ['ps', '--all', '--format', 'json'], capture_output=True, text=True)
            if checked.returncode:
                raise ValueError('RESTORE_CONFIG_REQUIRED')
            raw = checked.stdout.strip()
            try:
                rows = json.loads(raw) if raw.startswith('[') else [json.loads(line) for line in raw.splitlines() if line]
            except (ValueError, TypeError):
                raise ValueError('RESTORE_STATUS_INVALID')
            require_stopped(rows)
            # Keep STATE_DIRECTORY/restore-gate unchanged. Only PGDATA moves.
            raw_target = os.environ.get('POSTGRES_DATA_DIRECTORY', '')
            target = Path(raw_target)
            restore_root = Path(os.environ.get('KAMUI_POSTGRES_RESTORE_ROOT', str(state)))
            if restore_root != state or not raw_target or not target.is_absolute() or not restore_root.is_absolute() or target.is_symlink() or not target.is_dir() or target.resolve() != target or target.parent != restore_root or not target.name.startswith('postgres-restore-'):
                raise ValueError('RESTORE_EMPTY_REPLACEMENT_REQUIRED')
            if any(target.iterdir()):
                raise ValueError('RESTORE_TARGET_NOT_EMPTY')
            # No delta/force, no rm or implicit target creation. Host/state remain fenced.
            args = command + ['run', '--rm', '--no-deps', '-T', '-u', 'postgres', 'postgres', 'pgbackrest', '--config=/etc/pgbackrest/pgbackrest.conf', '--stanza=kamui', '--archive-mode=off', 'restore']
            if subprocess.run(args, stdout=diagnostics, stderr=diagnostics).returncode:
                raise ValueError('RESTORE_COMMAND_FAILED')
    print(json.dumps({'status': 'restored', 'admission': 'blocked'}))


if __name__ == '__main__':
    try:
        restore()
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch('[A-Z_]{3,60}', str(error)) else 'RESTORE_COMMAND_FAILED'
        print(json.dumps({'status': 'refused', 'error': code}), file=sys.stderr)
        sys.exit(1)
