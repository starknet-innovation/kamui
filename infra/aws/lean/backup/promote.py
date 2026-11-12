#!/usr/bin/env python3
"""Promote a restored PGDATA to the fixed runtime path without deleting old data."""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('kamui_restore', HERE/'restore.py')
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)


def promote_directories(state, target, rename=os.rename):
    canonical = state/'postgres'
    if state.resolve() != state or not target.is_absolute() or target.parent != state or not re.fullmatch('postgres-restore-[A-Za-z0-9][A-Za-z0-9._-]{0,100}', target.name) or target.is_symlink() or not target.is_dir() or target.resolve() != target:
        raise ValueError('PROMOTE_RESTORE_TARGET_INVALID')
    if target.stat().st_dev != state.stat().st_dev or os.path.ismount(target):
        raise ValueError('PROMOTE_SAME_FILESYSTEM_REQUIRED')
    version = target/'PG_VERSION'
    if version.is_symlink() or not version.is_file() or version.stat().st_size > 8 or version.read_text().strip() != '16' or (target/'postmaster.pid').exists() or (target/'postmaster.pid').is_symlink():
        raise ValueError('PROMOTE_STOPPED_RESTORED_DATABASE_REQUIRED')
    if canonical.is_symlink() or (canonical.exists() and not canonical.is_dir()):
        raise ValueError('PROMOTE_CANONICAL_PATH_INVALID')
    if canonical.exists() and (canonical.stat().st_dev != state.stat().st_dev or os.path.ismount(canonical)):
        raise ValueError('PROMOTE_SAME_FILESYSTEM_REQUIRED')
    if (canonical/'postmaster.pid').exists():
        raise ValueError('PROMOTE_DATABASE_STILL_ACTIVE')
    previous = state/('postgres-before-restore-' + uuid.uuid4().hex)
    # Every reviewed writer of these host paths holds the same lifecycle lock.
    # Never overwrite another destination, even if an operator left one behind.
    if previous.exists():
        raise ValueError('PROMOTE_ARCHIVE_ALREADY_EXISTS')
    moved_previous = False
    try:
        if canonical.exists():
            rename(canonical, previous)
            moved_previous = True
        if canonical.exists():
            raise ValueError('PROMOTE_CANONICAL_PATH_EXISTS')
        rename(target, canonical)
    except Exception:
        # Retain both data copies and blocked admission if any step cannot complete.
        if moved_previous and previous.exists() and not canonical.exists():
            try:
                rename(previous, canonical)
            except Exception:
                raise ValueError('PROMOTE_ROLLBACK_REQUIRES_OPERATOR')
        raise
    descriptor = os.open(state, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return previous if moved_previous else None


def main():
    if sys.argv[1:] != ['--writers-stopped']:
        raise ValueError('PROMOTE_STOP_WRITERS_REQUIRED')
    if os.environ.get('KAMUI_BACKUP_REVIEWED') != 'yes':
        raise ValueError('BACKUP_REVIEW_REQUIRED')
    state = Path(os.environ.get('STATE_DIRECTORY', '/var/lib/kamui'))
    target = Path(os.environ.get('POSTGRES_DATA_DIRECTORY', ''))
    compose = Path(os.environ.get('KAMUI_COMPOSE_FILE', '/opt/kamui/lean/backend/compose.yml'))
    manifest = Path(os.environ.get('KAMUI_ENV_FILE', '/etc/kamui/release.env'))
    if not compose.is_absolute() or not manifest.is_absolute() or not compose.is_file() or not manifest.is_file():
        raise ValueError('PROMOTE_CONFIG_REQUIRED')
    with restore.host.control_lock(state):
        command = ['docker', 'compose', '--env-file', str(manifest), '-f', str(compose)]
        block = command + ['--profile', 'operator', 'run', '--rm', '--no-deps', '-T', 'operator', 'bun', 'run', 'src/scripts/restore-control.ts', 'block']
        if subprocess.run(block, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            raise ValueError('RESTORE_FENCE_FAILED')
        checked = subprocess.run(command + ['ps', '--all', '--format', 'json'], capture_output=True, text=True)
        if checked.returncode:
            raise ValueError('RESTORE_STATUS_INVALID')
        raw = checked.stdout.strip()
        try:
            rows = json.loads(raw) if raw.startswith('[') else [json.loads(line) for line in raw.splitlines() if line]
        except (ValueError, TypeError):
            raise ValueError('RESTORE_STATUS_INVALID')
        restore.require_stopped(rows)
        previous = promote_directories(state, target)
    print(json.dumps({'status': 'promoted', 'admission': 'blocked', 'previousDataRetained': previous is not None}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch('[A-Z_]{3,60}', str(error)) else 'PROMOTE_FAILED'
        print(json.dumps({'status': 'refused', 'error': code}), file=sys.stderr)
        sys.exit(1)
