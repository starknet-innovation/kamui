#!/usr/bin/env python3
"""Operator-only local host lifecycle; does not call AWS, provision hosts or copy secrets."""
import json
import fcntl
from contextlib import contextmanager, nullcontext
import stat
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
IMAGE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[0-9a-f]{64}$')
IMAGE_KEYS = {'CADDY_IMAGE', 'KEYCHAIN_IMAGE', 'BACKEND_IMAGE', 'POSTGRES_IMAGE', 'PEPPER_IMAGE'}


def release(path, role):
    result = {}
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.partition('=')
        if not sep or key not in IMAGE_KEYS or key in result:
            raise ValueError('RELEASE_MANIFEST_INVALID')
        if value and not IMAGE.fullmatch(value):
            raise ValueError('IMAGE_DIGEST_REQUIRED')
        result[key] = value
    required = {'CADDY_IMAGE', 'PEPPER_IMAGE'} if role == 'pepper' else IMAGE_KEYS - {'PEPPER_IMAGE'}
    if any(not result.get(key) for key in required):
        raise ValueError('RELEASE_IMAGES_REQUIRED')
    return result


def canonical_data_directory(state):
    canonical = str(state/'postgres')
    override = os.environ.get('POSTGRES_DATA_DIRECTORY')
    if override and override != canonical:
        raise ValueError('RESTORED_DATA_PROMOTION_REQUIRED')
    return canonical


def assert_writers_stopped(rows):
    if any(row.get('Service') in {'api','rotator'} and row.get('State') not in {'exited','dead','created'} for row in rows):
        raise ValueError('STOP_OLD_WRITERS_REQUIRED')


@contextmanager
def control_lock(state):
    if not state.is_absolute() or state.is_symlink() or not state.is_dir():
        raise ValueError('STATE_DIRECTORY_REQUIRED')
    fd = os.open(state/'.operator.lock', os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError('HOST_CONTROL_LOCK_INVALID')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('HOST_CONTROL_BUSY')
        yield
    finally:
        os.close(fd)


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in {'backend', 'pepper'} or sys.argv[2] not in {'validate', 'pull', 'prepare', 'up', 'down', 'status'}:
        raise ValueError('USAGE_HOST_ROLE_ACTION')
    role, action = sys.argv[1:]
    config = Path(os.environ.get('CONFIG_DIRECTORY', '/etc/kamui'))
    state = Path(os.environ.get('STATE_DIRECTORY', '/var/lib/kamui'))
    if not config.is_absolute() or not state.is_absolute() or config.is_symlink() or state.is_symlink():
        raise ValueError('HOST_DIRECTORIES_INVALID')
    with control_lock(state) if action in {'pull','prepare','up','down'} else nullcontext():
        execute(role, action, config, state)


def execute(role, action, config, state):
    manifest = config / 'release.env'
    images = release(manifest, role)
    # Docker only receives public image references here. Per-service config/secrets are
    # resolved by Compose and must never be rendered with `compose config` (without --quiet).
    env = {**os.environ, **images, 'CONFIG_DIRECTORY': str(config), 'STATE_DIRECTORY': str(state), 'POSTGRES_DATA_DIRECTORY': canonical_data_directory(state)}
    command = ['docker', 'compose', '--env-file', str(manifest), '-f', str(ROOT/role/'compose.yml')]
    if os.environ.get('KAMUI_ENABLE_AVNU') == '1':
        if role != 'backend':
            raise ValueError('AVNU_BACKEND_ONLY')
        command += ['-f', str(ROOT/'backend/avnu.compose.yml')]
    if action == 'status':
        check = subprocess.run(command+['ps', '--all', '--format', 'json'], env=env, capture_output=True, text=True)
        if check.returncode:
            raise ValueError('COMPOSE_STATUS_FAILED')
        raw = check.stdout.strip()
        rows = json.loads(raw) if raw.startswith('[') else [json.loads(line) for line in raw.splitlines() if line]
        # Do not echo image registries, labels, addresses or command/environment fields.
        print(json.dumps([{'service': r.get('Service'), 'state': r.get('State'), 'health': r.get('Health')} for r in rows]))
        return
    if role == 'backend' and action in {'validate', 'up'}:
        def address(filename, key):
            for line in (config/filename).read_text().splitlines():
                name, sep, value = line.strip().partition('=')
                if sep and name == key and re.fullmatch('0x[0-9a-fA-F]{1,64}', value):
                    return int(value, 16)
            raise ValueError('SIGNER_ADDRESS_REQUIRED')
        if address('backend.public.env', 'RELAYER_ADDRESS') == address('rotator.public.env', 'OWNER_ADDRESS'):
            raise ValueError('SHARED_SIGNER_NONCE_COORDINATION_REQUIRED')
    if action == 'prepare' and role != 'backend':
        raise ValueError('PREPARE_BACKEND_ONLY')
    if role == 'backend' and action in {'up','prepare'}:
        checked = subprocess.run(command+['ps','--all','--format','json'],env=env,capture_output=True,text=True)
        if checked.returncode:
            raise ValueError('COMPOSE_STATUS_FAILED')
        raw = checked.stdout.strip()
        rows = json.loads(raw) if raw.startswith('[') else [json.loads(line) for line in raw.splitlines() if line]
        assert_writers_stopped(rows)
    if role == 'backend' and action == 'up':
        gate_directory = state/'restore-gate'
        gate_stat = gate_directory.lstat()
        if not stat.S_ISDIR(gate_stat.st_mode) or gate_directory.is_symlink() or gate_stat.st_uid != 0 or gate_stat.st_gid != 1000 or stat.S_IMODE(gate_stat.st_mode) != 0o750:
            raise ValueError('RESTORE_GATE_DIRECTORY_PERMISSIONS_REQUIRED')
        boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        marker = Path('/run/kamui/boot-fenced')
        if marker.is_symlink() or not marker.is_file() or marker.read_text().strip() != boot:
            raise ValueError('BOOT_FENCE_REQUIRED')
    args = {'prepare': ['up', '--detach', '--no-build', '--wait', '--wait-timeout', '180', 'postgres'], 'validate': ['config', '--quiet'], 'pull': ['pull'], 'up': ['up', '--detach', '--no-build', '--wait', '--wait-timeout', '180'], 'down': ['down', '--timeout', '30']}[action]
    # Image pulls and compose errors may contain private registry/account identifiers.
    code = subprocess.run(command+args, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode
    if code:
        raise ValueError('COMPOSE_ACTION_FAILED')
    print(json.dumps({'role': role, 'action': action, 'ok': True}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch('[A-Z_]{3,60}', str(error)) else 'HOST_ACTION_FAILED'
        print(json.dumps({'ok': False, 'error': code}), file=sys.stderr)
        sys.exit(1)
