#!/usr/bin/env python3
"""Root-only, first-install host preparation. Never starts Kamui or initializes data.

The delivery bootstrap must independently pin this installer's hash. The expected
manifest hash comes from that reviewed command, not from another downloaded file.
"""
import argparse
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import uuid

SCHEMA = 'kamui.host-install.v1'
HASH = re.compile(r'^[0-9a-f]{64}$')
IMAGE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[0-9a-f]{64}$')
IMAGE_KEYS = {'CADDY_IMAGE', 'KEYCHAIN_IMAGE', 'BACKEND_IMAGE', 'POSTGRES_IMAGE', 'PEPPER_IMAGE'}
PREFIXES = {'backend', 'pepper', 'caddy', 'scripts', 'systemd', 'backup', 'licenses'}
ROOT_FILES = {'README.md', 'VALIDATION.md', 'WALLET-MANUAL-VALIDATION-2026-11-12.md', 'release.env.example'}
COMMON = {'scripts/host.py', 'scripts/wallet-control.py', 'scripts/monitor.py',
          'scripts/secrets-sync.py', 'scripts/imds-guard.py',
          'systemd/kamui@.service', 'systemd/kamui-monitor@.service', 'systemd/kamui-monitor@.timer',
          'systemd/kamui-secrets@.service', 'systemd/kamui-imds-guard@.service'}
BACKEND = {'scripts/boot-fence.py', 'backend/init-app-role.sh',
           'backup/backup.sh', 'backup/restore.py', 'backup/restore.sh', 'backup/promote.py', 'backup/promote.sh',
           'backup/postgresql-backup.conf', 'backup/kamui-backup@.service', 'backup/kamui-backup-full.timer',
           'backup/kamui-backup-check.timer', 'systemd/kamui-backend-boot-fence.service',
           'systemd/kamui@backend.service.d/restore-fence.conf'}


def sha(value): return hashlib.sha256(value).hexdigest()


def hash_string(value):
    if not isinstance(value, str) or not HASH.fullmatch(value): raise ValueError('INSTALL_HASH_REQUIRED')
    return value


def root_owned(info):
    """Production trust predicate; fake-root tests replace this predicate only."""
    return info.st_uid == 0 and info.st_gid == 0


def set_root_owner(fd): os.fchown(fd, 0, 0)


def _read_file(path, limit, managed=False, mode=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            raise ValueError('INSTALL_INPUT_INVALID')
        if managed and (not root_owned(info) or (mode is not None and stat.S_IMODE(info.st_mode) != mode) or (mode is None and info.st_mode & 0o022)):
            raise ValueError('MANAGED_FILE_OWNERSHIP_OR_MODE_INVALID')
        value = os.read(fd, limit + 1)
        if len(value) > limit: raise ValueError('INSTALL_INPUT_TOO_LARGE')
        return value
    finally: os.close(fd)


def read_regular(path, limit): return _read_file(path, limit)


def read_managed(path, limit, mode=None): return _read_file(path, limit, managed=True, mode=mode)


def os_identity(paths):
    # AL2023 may use the standard /etc/os-release -> ../usr/lib/os-release link.
    # Do not relax Paths.at for any other installed file or symlink target.
    identity = paths.at('/etc')/'os-release'
    if identity.is_symlink():
        if os.readlink(identity) not in {'../usr/lib/os-release', '/usr/lib/os-release'} or not root_owned(identity.lstat()):
            raise ValueError('OS_IDENTITY_SYMLINK_REFUSED')
        identity = paths.at('/usr/lib/os-release')
    else:
        identity = paths.at('/etc/os-release')
    return read_managed(identity, 65536).decode()


def public_path(name):
    if not isinstance(name, str) or len(name) > 240 or not re.fullmatch(r'[A-Za-z0-9@._/-]+', name):
        raise ValueError('PACKAGE_PATH_REFUSED')
    parts = PurePosixPath(name).parts
    if not parts or PurePosixPath(name).is_absolute() or any(p in {'.', '..', ''} or p.startswith('.') for p in name.split('/')):
        raise ValueError('PACKAGE_PATH_REFUSED')
    if len(parts) == 1:
        if name not in ROOT_FILES: raise ValueError('PACKAGE_ROOT_FILE_REFUSED')
    elif parts[0] not in PREFIXES:
        raise ValueError('PACKAGE_PREFIX_REFUSED')
    if any(p.lower() in {'secrets', 'state', 'logs', 'operator', 'node_modules', '__pycache__'} for p in parts):
        raise ValueError('PRIVATE_PACKAGE_PATH_REFUSED')
    if name.endswith(('.env', '.env.local', '.private.env', '.pyc')) or re.search(r'(?:PRIVATE_KEY|DATABASE_URL|POSTGRES_PASSWORD|APP_DATABASE_PASSWORD)', name):
        raise ValueError('PRIVATE_PACKAGE_PATH_REFUSED')
    return name


def parse_manifest(raw, expected_hash, role):
    if sha(raw) != hash_string(expected_hash): raise ValueError('MANIFEST_HASH_MISMATCH')
    value = json.loads(raw)
    if not isinstance(value, dict) or set(value) != {'schema', 'role', 'archiveSha256', 'files', 'releaseImages', 'compose'} or value['schema'] != SCHEMA or value['role'] != role or role not in {'backend', 'pepper'}:
        raise ValueError('INSTALL_MANIFEST_INVALID')
    hash_string(value['archiveSha256'])
    files = value['files']
    if not isinstance(files, dict) or not 1 <= len(files) <= 512: raise ValueError('PACKAGE_FILES_INVALID')
    for name, pin in files.items():
        public_path(name)
        if not isinstance(pin, dict) or set(pin) != {'sha256', 'mode'} or pin['mode'] not in {'0644', '0755'}:
            raise ValueError('PACKAGE_FILE_PIN_INVALID')
        hash_string(pin['sha256'])
    required = COMMON | {role+'/compose.yml', 'caddy/'+role+'.Caddyfile'} | (BACKEND if role == 'backend' else set())
    if not required <= set(files): raise ValueError('REQUIRED_PACKAGE_FILES_MISSING')
    if any(files[name]['mode'] != '0755' for name in required if name.endswith('.sh')):
        raise ValueError('REQUIRED_EXECUTABLE_MODE')
    images = value['releaseImages']
    if not isinstance(images, dict) or set(images) != IMAGE_KEYS or any(not isinstance(v, str) or not IMAGE.fullmatch(v) for v in images.values()):
        raise ValueError('RELEASE_IMAGES_INVALID')
    compose = value['compose']
    if not isinstance(compose, dict) or set(compose) != {'version', 'sha256'} or not re.fullmatch(r'v2\.[0-9]+\.[0-9]+', compose.get('version', '')):
        raise ValueError('COMPOSE_PIN_INVALID')
    hash_string(compose['sha256'])
    return value


def unpack_verified(data, manifest, destination):
    if sha(data) != manifest['archiveSha256']: raise ValueError('PACKAGE_HASH_MISMATCH')
    found = set(); count = 0; total = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:*') as archive:
        for member in archive:
            count += 1
            if count > 1024: raise ValueError('PACKAGE_MEMBER_LIMIT')
            name = member.name.rstrip('/')
            if name == 'lean' and member.isdir(): continue
            if not name.startswith('lean/'): raise ValueError('PACKAGE_ROOT_REQUIRED')
            relative = name[5:]
            if member.isdir():
                # Directory metadata is ignored; no links or device extraction.
                if relative.startswith('/') or any(p in {'', '.', '..'} or p.startswith('.') for p in relative.split('/')):
                    raise ValueError('PACKAGE_PATH_REFUSED')
                continue
            public_path(relative)
            if not member.isfile() or member.issym() or member.islnk() or member.pax_headers:
                raise ValueError('PACKAGE_MEMBER_TYPE_REFUSED')
            if relative not in manifest['files'] or relative in found or member.size > 2 * 1024 * 1024:
                raise ValueError('PACKAGE_MEMBER_REFUSED')
            total += member.size
            if total > 32 * 1024 * 1024: raise ValueError('PACKAGE_EXPANSION_LIMIT')
            stream = archive.extractfile(member)
            if stream is None: raise ValueError('PACKAGE_MEMBER_INVALID')
            body = stream.read(2 * 1024 * 1024 + 1)
            if len(body) != member.size or sha(body) != manifest['files'][relative]['sha256']:
                raise ValueError('PACKAGE_FILE_HASH_MISMATCH')
            path = destination/relative
            path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            with open(path, 'xb') as output: output.write(body); output.flush(); os.fsync(output.fileno())
            path.chmod(int(manifest['files'][relative]['mode'], 8))
            found.add(relative)
    if found != set(manifest['files']): raise ValueError('PACKAGE_FILES_MISSING')


class Paths:
    def __init__(self, root=Path('/')): self.root = Path(root).resolve()
    def at(self, value):
        path = self.root/value.lstrip('/')
        current = self.root
        for component in path.relative_to(self.root).parts:
            current = current/component
            if current.is_symlink(): raise ValueError('INSTALL_SYMLINK_REFUSED')
        return path


def directory(path, mode, uid=0, gid=0):
    if path.exists():
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or path.is_symlink() or info.st_uid != uid or info.st_gid != gid or stat.S_IMODE(info.st_mode) != mode:
            raise ValueError('EXISTING_DIRECTORY_LAYOUT_MISMATCH')
        return
    path.mkdir(mode=mode, parents=True)
    os.chown(path, uid, gid); path.chmod(mode)


def install_file(path, body, mode=0o644, limit=4*1024*1024):
    """`limit` must admit the largest body this path may legitimately already hold."""
    if path.exists() or path.is_symlink():
        if path.is_symlink() or read_managed(path, limit, mode) != body:
            raise ValueError('EXISTING_FILE_DIFFERS_REFUSE_OVERWRITE')
        return
    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    set_root_owner(fd)
    with os.fdopen(fd, 'wb') as output: output.write(body); output.flush(); os.fsync(output.fileno())
    path.chmod(mode)


def replace_file(path, body, mode, allowed, limit=4*1024*1024):
    """Pre-start replacement only: the current content must be one we expect."""
    if path.is_symlink(): raise ValueError('MANAGED_FILE_SYMLINK_REFUSED')
    if path.exists():
        current = read_managed(path, limit, mode)
        if current == body: return
        if current not in allowed: raise ValueError('INSTALLED_FILE_CHANGED_REFUSE_REPLACE')
    temporary = path.parent/('.replace-'+uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        set_root_owner(fd)
        with os.fdopen(fd, 'wb') as output: output.write(body); output.flush(); os.fsync(output.fileno())
        temporary.chmod(mode)
        os.rename(temporary, path)
    finally:
        if temporary.exists(): temporary.unlink()


def has_wallet_state(state):
    """Any file or link under the state directory counts as wallet state, except the empty lock the
    host tool takes for every prepare/up/down. That lock holds no data; a non-empty one, a link in
    its place, or the same name anywhere deeper still counts."""
    for path in state.rglob('*'):
        if path.is_symlink(): return True
        if not path.is_file(): continue
        if path.parent == state and path.name == '.operator.lock':
            info = path.lstat()
            if info.st_size == 0 and info.st_nlink == 1: continue
        return True
    return False


def unstarted_receipt(value, role):
    """A replaceable receipt is a well-formed, never-started install of the same role."""
    if not isinstance(value, dict) or set(value) != {'schema', 'role', 'manifestSha256', 'archiveSha256', 'walletStarted'}:
        raise ValueError('INSTALLED_RECEIPT_INVALID')
    if value['schema'] != SCHEMA or value['role'] != role: raise ValueError('INSTALLED_RECEIPT_INVALID')
    if value['walletStarted'] is not False: raise ValueError('STARTED_WALLET_REQUIRES_REVIEWED_UPGRADE')
    hash_string(value['manifestSha256']); hash_string(value['archiveSha256'])
    return value


class Runner:
    def __init__(self, directory): self.directory = directory
    def run(self, args, check=True):
        stem = uuid.uuid4().hex
        env = {k: v for k, v in os.environ.items() if k not in {'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'}}
        env.update(SYSTEMD_PAGER='', SYSTEMD_COLORS='0', DOCKER_HOST='unix:///var/run/docker.sock')
        try: result = subprocess.run(args, capture_output=True, timeout=600, env=env)
        except FileNotFoundError:
            if check: raise ValueError('INSTALL_COMMAND_UNAVAILABLE') from None
            result = subprocess.CompletedProcess(args, 127, b'', b'')
        except Exception: raise ValueError('INSTALL_COMMAND_UNCERTAIN_SEE_PRIVATE_LOGS') from None
        for suffix, value in [('stdout', result.stdout), ('stderr', result.stderr)]:
            install_file(self.directory/(stem+'-'+suffix), value, 0o600)
        if check and result.returncode: raise ValueError('INSTALL_COMMAND_FAILED_SEE_PRIVATE_LOGS')
        return result


def version(result): return result.stdout.decode(errors='strict').strip().removeprefix('v')


def prerequisites(paths, run, manifest, compose_binary=None, compose_sha256=None):
    release = os_identity(paths)
    values = dict(line.split('=', 1) for line in release.splitlines() if '=' in line)
    if values.get('ID', '').strip('"') != 'amzn' or values.get('VERSION_ID', '').strip('"') != '2023' or platform.machine() != 'x86_64':
        raise ValueError('AL2023_X86_HOST_REQUIRED')
    if run(['systemctl', 'is-active', '--quiet', 'amazon-ssm-agent.service'], False).returncode:
        raise ValueError('SSM_AGENT_MUST_ALREADY_BE_ACTIVE')
    for unit in ['kamui@backend.service', 'kamui@pepper.service', 'kamui-backend-boot-fence.service',
                 'kamui-monitor@backend.timer', 'kamui-monitor@pepper.timer', 'kamui-backup-full.timer', 'kamui-backup-check.timer']:
        active_unit = run(['systemctl', 'is-active', '--quiet', unit], False).returncode == 0
        load = run(['systemctl', 'show', '--property=LoadState', '--value', unit], False)
        if not active_unit and load.stdout.decode(errors='strict').strip() == 'not-found':
            continue
        enabled = run(['systemctl', 'is-enabled', unit], False)
        enabled_state = enabled.stdout.decode(errors='strict').strip()
        # is-enabled returns success for static units too. Static boot-fence units
        # are installed but not enabled; do not mistake that for autostart.
        if active_unit or enabled_state not in {'disabled', 'static', 'not-found'}:
            raise ValueError('EXISTING_KAMUI_UNIT_MUST_BE_STOPPED_DISABLED')
    active = run(['systemctl', 'is-active', '--quiet', 'docker.service'], False).returncode == 0
    if active:
        if run(['docker', 'ps', '-aq']).stdout.strip(): raise ValueError('EXISTING_DOCKER_CONTAINERS_REFUSE_INSTALL')
    else:
        data = paths.at('/var/lib/docker')
        if data.exists() and any(data.iterdir()): raise ValueError('UNKNOWN_DOCKER_STATE_REFUSE_START')
        custom = [paths.at('/etc/docker/daemon.json'), paths.at('/etc/systemd/system/docker.service')]
        overrides = paths.at('/etc/systemd/system/docker.service.d')
        if any(p.exists() for p in custom) or overrides.exists() and any(overrides.iterdir()):
            raise ValueError('CUSTOM_DOCKER_DAEMON_REQUIRES_REVIEW')
    if run(['rpm', '-q', 'docker'], False).returncode:
        run(['dnf', '-y', 'install', 'docker'])
    if run(['aws', '--version'], False).returncode:
        run(['dnf', '-y', 'install', 'awscli-2'])
    aws = run(['aws', '--version'])
    if not aws.stdout.startswith(b'aws-cli/2.'): raise ValueError('AWS_CLI_V2_REQUIRED')
    if compose_binary is not None:
        body = read_regular(compose_binary, 160*1024*1024)
        if sha(body) != manifest['compose']['sha256'] or compose_sha256 != manifest['compose']['sha256'] or not body.startswith(b'\x7fELF'):
            raise ValueError('COMPOSE_BINARY_PIN_MISMATCH')
        # The pinned Compose binary is far larger than install_file's default read limit.
        install_file(paths.at('/usr/local/lib/docker/cli-plugins/docker-compose'), body, 0o755, limit=160*1024*1024)
    plugin = paths.at('/usr/local/lib/docker/cli-plugins/docker-compose')
    if not plugin.is_file() or sha(read_managed(plugin, 160*1024*1024, 0o755)) != manifest['compose']['sha256']:
        raise ValueError('PINNED_COMPOSE_BINARY_REQUIRED')
    if not active: run(['systemctl', 'start', 'docker.service'])
    run(['docker', 'info', '--format', '{{.ServerVersion}}'])
    if version(run(['docker', 'compose', 'version', '--short'])) != manifest['compose']['version'].removeprefix('v'):
        raise ValueError('COMPOSE_VERSION_MISMATCH')


def install(role, archive_path, manifest_path, expected_manifest, compose_binary=None, compose_sha256=None, paths=None, runner=None, require_root=True, replace_unstarted=False):
    if require_root and (os.geteuid() != 0 or os.getegid() != 0): raise ValueError('ROOT_REQUIRED')
    paths = paths or Paths()
    raw = read_regular(manifest_path, 1024*1024)
    manifest = parse_manifest(raw, expected_manifest, role)
    data = read_regular(archive_path, 64*1024*1024)
    if compose_binary is not None:
        compose = read_regular(compose_binary, 160*1024*1024)
        if compose_sha256 != manifest['compose']['sha256'] or sha(compose) != compose_sha256 or not compose.startswith(b'\x7fELF'):
            raise ValueError('COMPOSE_BINARY_PIN_MISMATCH')
    # Verify the archive entirely before running package-manager/system commands.
    with tempfile.TemporaryDirectory(prefix='kamui-public-verify-') as temporary:
        checked = Path(temporary)/'lean'; checked.mkdir()
        unpack_verified(data, manifest, checked)
        records = paths.at('/var/lib/kamui-install'); directory(records, 0o700)
        lock = os.open(records/'.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: raise ValueError('HOST_INSTALL_BUSY') from None
            receipt_path = records/(role+'.json')
            receipt = {'schema': SCHEMA, 'role': role, 'manifestSha256': sha(raw), 'archiveSha256': manifest['archiveSha256'], 'walletStarted': False}
            previous = None
            if receipt_path.exists():
                existing = json.loads(read_managed(receipt_path, 4096, 0o600))
                if existing == receipt:
                    verify_installed(paths, manifest, receipt)
                    return {'status': 'already_installed_verified', 'walletStarted': False}
                # A different release replaces the installed one only when explicitly
                # requested and nothing was ever started or written by the wallet.
                if not replace_unstarted: raise ValueError('DIFFERENT_RELEASE_REQUIRES_REVIEWED_UPGRADE')
                previous = unstarted_receipt(existing, role)
            state = paths.at('/var/lib/kamui')
            if state.exists() and has_wallet_state(state):
                raise ValueError('EXISTING_WALLET_STATE_REQUIRES_REVIEWED_UPGRADE')
            release_trees = paths.at('/opt/kamui/releases')
            expected_tree = release_trees/manifest['archiveSha256']/'lean'
            existing_link = paths.root/'opt/kamui/lean'
            if previous is not None:
                old_tree = release_trees/previous['archiveSha256']/'lean'
                # A crash mid-replacement may already have swapped the link.
                if not existing_link.is_symlink() or existing_link.resolve() not in {old_tree.resolve(), expected_tree.resolve()}:
                    raise ValueError('INSTALLED_PACKAGE_LINK_CHANGED')
            elif existing_link.is_symlink() and existing_link.resolve() != expected_tree.resolve():
                raise ValueError('DIFFERENT_RELEASE_REQUIRES_REVIEWED_UPGRADE')
            if existing_link.exists() and not existing_link.is_symlink(): raise ValueError('EXISTING_PACKAGE_REFUSE_REPLACE')
            images = ''.join(key+'='+manifest['releaseImages'][key]+'\n' for key in sorted(IMAGE_KEYS)).encode()
            existing_manifest = paths.at('/etc/kamui/release.env')
            if previous is None and existing_manifest.exists() and read_managed(existing_manifest, 8192, 0o600) != images:
                raise ValueError('EXISTING_FILE_DIFFERS_REFUSE_OVERWRITE')
            existing_plugin = paths.at('/usr/local/lib/docker/cli-plugins/docker-compose')
            if existing_plugin.exists() and sha(read_managed(existing_plugin, 160*1024*1024, 0o755)) != manifest['compose']['sha256']:
                raise ValueError('INSTALLED_COMPOSE_CHANGED')
            logs = paths.at('/var/log/kamui-install'); directory(logs, 0o700)
            commands = runner or Runner(logs)
            prerequisites(paths, commands.run, manifest, compose_binary, compose_sha256)
            release_root = paths.at('/opt/kamui/releases'); directory(release_root, 0o755)
            destination = release_root/manifest['archiveSha256']
            if destination.exists():
                verify_tree(destination/'lean', manifest)
            else:
                stage = Path(tempfile.mkdtemp(prefix='.install-', dir=release_root))
                try:
                    shutil.copytree(checked, stage/'lean')
                    os.rename(stage, destination)
                finally:
                    if stage.exists(): shutil.rmtree(stage)
            link = paths.root/'opt/kamui/lean'
            if previous is not None:
                # Keep evidence of what was replaced before changing anything visible. Name it by
                # the manifest hash: the archive hash is unchanged when only images differ, so it
                # would collide with an earlier record and refuse the replacement.
                install_file(records/(role+'-superseded-'+previous['manifestSha256'][:16]+'.json'),
                             (json.dumps(previous, sort_keys=True)+'\n').encode(), 0o600)
                if link.resolve() != (destination/'lean').resolve():
                    swap = link.parent/('.lean-replace-'+uuid.uuid4().hex)
                    os.symlink(destination/'lean', swap)
                    try: os.rename(swap, link)
                    finally:
                        if swap.is_symlink(): swap.unlink()
            elif link.is_symlink():
                if link.resolve() != (destination/'lean').resolve(): raise ValueError('DIFFERENT_RELEASE_REQUIRES_REVIEWED_UPGRADE')
            elif link.exists(): raise ValueError('EXISTING_PACKAGE_REFUSE_REPLACE')
            else: os.symlink(destination/'lean', link)
            config = paths.at('/etc/kamui'); directory(config, 0o700)
            for name in ['secrets', 'operator', 'backup']: directory(config/name, 0o700)
            images = ''.join(key+'='+manifest['releaseImages'][key]+'\n' for key in sorted(IMAGE_KEYS)).encode()
            if previous is not None:
                # The old image list is not recoverable from the receipt; replace only a
                # regular root-owned 0600 file that already holds a well-formed list.
                current = read_managed(config/'release.env', 8192, 0o600) if (config/'release.env').exists() else None
                if current is not None and current != images and not re.fullmatch(rb'(?:[A-Z_]+_IMAGE=[^\n]+\n){5}', current):
                    raise ValueError('INSTALLED_FILE_CHANGED_REFUSE_REPLACE')
                replace_file(config/'release.env', images, 0o600, {current} if current else set())
            else:
                install_file(config/'release.env', images, 0o600)
            directory(state, 0o700)
            for name in ['caddy', 'caddy-config']: directory(state/name, 0o700)
            if role == 'backend':
                directory(state/'postgres', 0o700, 999, 999)
                directory(state/'restore-gate', 0o750, 0, 1000)
            unit_root = paths.at('/etc/systemd/system'); unit_root.mkdir(parents=True, exist_ok=True)
            lean = destination/'lean'
            units = ['systemd/kamui@.service', 'systemd/kamui-monitor@.service', 'systemd/kamui-monitor@.timer',
             'systemd/kamui-secrets@.service', 'systemd/kamui-imds-guard@.service']
            if role == 'backend': units += ['systemd/kamui-backend-boot-fence.service', 'systemd/kamui@backend.service.d/restore-fence.conf',
                'backup/kamui-backup@.service', 'backup/kamui-backup-full.timer', 'backup/kamui-backup-check.timer']
            for relative in units:
                target = paths.at('/etc/systemd/system/'+relative.removeprefix('systemd/').removeprefix('backup/'))
                body = read_regular(lean/relative, 1024*1024)
                if previous is None:
                    install_file(target, body)
                else:
                    # Only the unit the previous release installed may be replaced.
                    old = release_trees/previous['archiveSha256']/'lean'/relative
                    allowed = {read_managed(old, 1024*1024)} if old.is_file() and not old.is_symlink() else set()
                    replace_file(target, body, 0o644, allowed)
            commands.run(['systemctl', 'daemon-reload'])
            # Deliberately no enable/start Kamui/backup/monitor units and no DB/gate action.
            if previous is None:
                install_file(receipt_path, (json.dumps(receipt, sort_keys=True)+'\n').encode(), 0o600)
            else:
                replace_file(receipt_path, (json.dumps(receipt, sort_keys=True)+'\n').encode(), 0o600,
                             {(json.dumps(previous, sort_keys=True)+'\n').encode()})
            verify_installed(paths, manifest, receipt)
            return {'status': 'host_replaced_wallet_stopped' if previous else 'host_installed_wallet_stopped',
                    'walletStarted': False, 'databaseInitialized': False, 'unitsEnabled': False}
        finally: os.close(lock)


def verify_tree(tree, manifest):
    for directory in [tree.parent, tree] + [p for p in tree.rglob('*') if p.is_dir() or p.is_symlink()]:
        info = directory.lstat()
        if directory.is_symlink() or not stat.S_ISDIR(info.st_mode) or not root_owned(info) or info.st_mode & 0o022:
            raise ValueError('INSTALLED_PACKAGE_DIRECTORY_UNTRUSTED')
    for relative, pin in manifest['files'].items():
        path = tree/relative
        if sha(read_managed(path, 2*1024*1024, int(pin['mode'], 8))) != pin['sha256']:
            raise ValueError('INSTALLED_PACKAGE_CHANGED')


def verify_installed(paths, manifest, receipt):
    link = paths.root/'opt/kamui/lean'
    expected = paths.at('/opt/kamui/releases')/receipt['archiveSha256']/'lean'
    if not link.is_symlink() or link.resolve() != expected.resolve(): raise ValueError('INSTALLED_PACKAGE_LINK_CHANGED')
    verify_tree(expected, manifest)
    images = ''.join(key+'='+manifest['releaseImages'][key]+'\n' for key in sorted(IMAGE_KEYS)).encode()
    if read_managed(paths.at('/etc/kamui/release.env'), 8192, 0o600) != images: raise ValueError('INSTALLED_RELEASE_MANIFEST_CHANGED')
    units = ['systemd/kamui@.service', 'systemd/kamui-monitor@.service', 'systemd/kamui-monitor@.timer',
             'systemd/kamui-secrets@.service', 'systemd/kamui-imds-guard@.service']
    if manifest['role'] == 'backend': units += ['systemd/kamui-backend-boot-fence.service', 'systemd/kamui@backend.service.d/restore-fence.conf',
        'backup/kamui-backup@.service', 'backup/kamui-backup-full.timer', 'backup/kamui-backup-check.timer']
    for relative in units:
        target = paths.at('/etc/systemd/system/'+relative.removeprefix('systemd/').removeprefix('backup/'))
        if read_managed(target, 1024*1024, 0o644) != read_managed(expected/relative, 1024*1024, int(manifest['files'][relative]['mode'], 8)):
            raise ValueError('INSTALLED_UNIT_CHANGED')


def check(role, archive_path, manifest_path, expected_manifest, paths=None, runner=None, require_root=True):
    if require_root and (os.geteuid() != 0 or os.getegid() != 0): raise ValueError('ROOT_REQUIRED')
    paths = paths or Paths()
    raw = read_regular(manifest_path, 1024*1024)
    manifest = parse_manifest(raw, expected_manifest, role)
    if sha(read_regular(archive_path, 64*1024*1024)) != manifest['archiveSha256']: raise ValueError('PACKAGE_HASH_MISMATCH')
    receipt = {'schema': SCHEMA, 'role': role, 'manifestSha256': sha(raw), 'archiveSha256': manifest['archiveSha256'], 'walletStarted': False}
    if json.loads(read_managed(paths.at('/var/lib/kamui-install')/(role+'.json'), 4096, 0o600)) != receipt:
        raise ValueError('INSTALLED_RECEIPT_CHANGED')
    verify_installed(paths, manifest, receipt)
    # Authenticate the executable before invoking `docker compose`, not after it.
    if sha(read_managed(paths.at('/usr/local/lib/docker/cli-plugins/docker-compose'), 160*1024*1024, 0o755)) != manifest['compose']['sha256']:
        raise ValueError('INSTALLED_COMPOSE_CHANGED')
    # Read-only dependency observations. No package install, service start or log writes.
    def local_run(args):
        if runner is not None: return runner.run(args)
        env = {k: v for k, v in os.environ.items() if k not in {'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'}}
        env.update(SYSTEMD_PAGER='', SYSTEMD_COLORS='0', DOCKER_HOST='unix:///var/run/docker.sock')
        result = subprocess.run(args, capture_output=True, timeout=30, env=env)
        if result.returncode: raise ValueError('INSTALLED_DEPENDENCY_CHECK_FAILED')
        return result
    local_run(['systemctl', 'is-active', '--quiet', 'amazon-ssm-agent.service'])
    if not local_run(['aws', '--version']).stdout.startswith(b'aws-cli/2.'): raise ValueError('AWS_CLI_V2_REQUIRED')
    local_run(['docker', 'info', '--format', '{{.ServerVersion}}'])
    if version(local_run(['docker', 'compose', 'version', '--short'])) != manifest['compose']['version'].removeprefix('v'):
        raise ValueError('COMPOSE_VERSION_MISMATCH')
    return {'status': 'public_host_install_verified', 'walletStartedByThisCommand': False, 'runtimeConfigurationVerified': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--role', choices=['backend', 'pepper'], required=True)
    parser.add_argument('--archive', required=True)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--compose-binary')
    parser.add_argument('--compose-sha256')
    parser.add_argument('--check', action='store_true', help='Read-only verification of the installed public package/dependencies')
    parser.add_argument('--replace-unstarted', action='store_true', help='Replace a different installed release only if the wallet never started')
    args = parser.parse_args()
    if args.check and args.replace_unstarted: raise ValueError('CHECK_CANNOT_REPLACE')
    if args.check:
        print(json.dumps(check(args.role, args.archive, args.manifest, args.manifest_sha256)))
    else:
        print(json.dumps(install(args.role, args.archive, args.manifest, args.manifest_sha256, args.compose_binary, args.compose_sha256,
                                 replace_unstarted=args.replace_unstarted)))


if __name__ == '__main__':
    try: main()
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch('[A-Z_]{3,100}', str(error)) else 'HOST_INSTALL_REFUSED_PRIVATE_LOGS_RETAINED'
        print(code); raise SystemExit(1)
