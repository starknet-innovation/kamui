#!/usr/bin/env python3
"""User-run release, local runtime preparation, and public host installation.

No private runtime file is uploaded, placed in an image, or passed to SSM.
No wallet service, PostgreSQL instance or paid admission is started here.
"""
import argparse
import fcntl
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tarfile
import urllib.request

from common import Aws, AwsError, Driver, HERE, base, private_dir, read_private, sha, write_private

REPO = HERE.parents[3]
COMPOSE_VERSION = 'v2.40.3'
COMPOSE_SHA = 'dba9d98e1ba5bfe11d88c99b9bd32fc4a0624a30fafe68eea34d61a3e42fd372'
COMPOSE_URL = f'https://github.com/docker/compose/releases/download/{COMPOSE_VERSION}/docker-compose-linux-x86_64'
ROLES = ('backend', 'pepper')
FILES = {
    'backend/compose.yml', 'backend/init-app-role.sh', 'pepper/compose.yml',
    'caddy/backend.Caddyfile', 'caddy/pepper.Caddyfile',
    'scripts/host.py', 'scripts/wallet-control.py', 'scripts/monitor.py', 'scripts/boot-fence.py',
    'systemd/kamui@.service', 'systemd/kamui-monitor@.service', 'systemd/kamui-monitor@.timer',
    'systemd/kamui-backend-boot-fence.service', 'systemd/kamui@backend.service.d/restore-fence.conf',
    'backup/backup.sh', 'backup/restore.py', 'backup/restore.sh', 'backup/promote.py', 'backup/promote.sh',
    'backup/postgresql-backup.conf', 'backup/kamui-backup@.service',
    'backup/kamui-backup-full.timer', 'backup/kamui-backup-check.timer', 'release.env.example',
    'licenses/docker-compose-LICENSE', 'licenses/docker-compose-NOTICE', 'licenses/kamui-LICENSE',
}


def load(name):
    spec = importlib.util.spec_from_file_location('kamui_install_'+name, HERE/(name+'.py'))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


def preserve_bytes(path, data):
    if path.exists() or path.is_symlink():
        if read_private(path, limit=200*1024*1024) != data: raise ValueError('INSTALL_ARTIFACT_CHANGED')
        return
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as output: output.write(data); output.flush(); os.fsync(output.fileno())
    base.sync(path.parent)


def committed_source(revision, repo=REPO):
    head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=repo, capture_output=True, text=True, check=True).stdout.strip()
    dirty = subprocess.run(['git', 'status', '--porcelain', '--untracked-files=all'], cwd=repo, capture_output=True, text=True, check=True).stdout
    if dirty: raise ValueError('INSTALL_REQUIRES_CLEAN_REVIEWED_RELEASE_REVISION')
    if head != revision:
        ancestor=subprocess.run(['git','merge-base','--is-ancestor',revision,head],cwd=repo,capture_output=True)
        if ancestor.returncode:raise ValueError('INSTALL_RELEASE_SOURCE_NOT_ANCESTOR')
        changed=subprocess.run(['git','diff','--name-only','-z',revision,head],cwd=repo,capture_output=True,text=True,check=True).stdout
        if not load('release').infrastructure_only([p for p in changed.split('\0') if p]):
            raise ValueError('INSTALL_APPLICATION_SOURCE_CHANGED')


def package(root, manifest, repo=REPO, compose_download=None):
    """Exact explicit public allowlist, separate from installation/runtime."""
    if manifest.get('schema') != 'kamui.release.v1' or manifest.get('architecture') != 'linux/amd64':
        raise ValueError('INSTALL_RELEASE_MANIFEST_INVALID')
    revision = manifest.get('sourceRevision', '')
    if not re.fullmatch('[a-f0-9]{40}', revision): raise ValueError('INSTALL_SOURCE_REVISION_REQUIRED')
    committed_source(revision, repo)
    directory = private_dir(private_dir(Path(root)/'installation')/'package')
    contents = {}; pins = {}
    for relative in sorted(FILES):
        source = repo/'infra/aws/lean'/relative
        if source.is_symlink() or not source.is_file(): raise ValueError('INSTALL_PUBLIC_FILE_REQUIRED')
        data = source.read_bytes()
        # Explicit filenames, not recursive working-tree archiving.
        if len(data) > 2*1024*1024: raise ValueError('INSTALL_PUBLIC_FILE_TOO_LARGE')
        mode = '0755' if relative.endswith('.sh') else '0644'
        contents[relative] = data; pins[relative] = {'sha256': sha(data), 'mode': mode}
    installer_path = repo/'infra/aws/lean/install/host_install.py'
    if installer_path.is_symlink() or not installer_path.is_file(): raise ValueError('INSTALL_PUBLIC_INSTALLER_REQUIRED')
    installer = installer_path.read_bytes()
    preserve_bytes(directory/'host-install.py', installer)
    puller_path = repo/'infra/aws/lean/install/image_pull.py'
    if puller_path.is_symlink() or not puller_path.is_file(): raise ValueError('INSTALL_PUBLIC_IMAGE_HELPER_REQUIRED')
    puller = puller_path.read_bytes()
    preserve_bytes(directory/'pull-images.py', puller)
    compose = directory/'compose-linux-x86_64'
    if compose.exists():
        if sha(read_private(compose, limit=200*1024*1024)) != COMPOSE_SHA: raise ValueError('INSTALL_COMPOSE_PIN_MISMATCH')
    else:
        # HTTPS GitHub release, committed version and independently pinned checksum.
        download = compose_download or (lambda: urllib.request.urlopen(COMPOSE_URL, timeout=60))
        temporary = directory/'.compose-download'
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        total = 0; digest = hashlib.sha256()
        with os.fdopen(descriptor, 'wb') as output, download() as response:
            while True:
                chunk = response.read(65536)
                if not chunk: break
                total += len(chunk)
                if total > 200*1024*1024: raise ValueError('INSTALL_COMPOSE_TOO_LARGE')
                digest.update(chunk); output.write(chunk)
            output.flush(); os.fsync(output.fileno())
        if digest.hexdigest() != COMPOSE_SHA: raise ValueError('INSTALL_COMPOSE_PIN_MISMATCH')
        os.rename(temporary, compose); base.sync(directory)
    artifacts = {'installer': {'path': str(directory/'host-install.py'), 'sha256': sha(installer)},
                 'puller': {'path': str(directory/'pull-images.py'), 'sha256': sha(puller)},
                 'compose': {'path': str(compose), 'sha256': COMPOSE_SHA}, 'roles': {}}
    for role in ROLES:
        stream = io.BytesIO()
        with gzip.GzipFile(fileobj=stream, mode='wb', mtime=0, filename='') as gz:
            with tarfile.open(fileobj=gz, mode='w', format=tarfile.USTAR_FORMAT) as archive:
                for relative, data in contents.items():
                    info = tarfile.TarInfo('lean/'+relative); info.size = len(data); info.mode = int(pins[relative]['mode'], 8)
                    info.mtime = 0; info.uid = 0; info.gid = 0; info.uname = ''; info.gname = ''
                    archive.addfile(info, io.BytesIO(data))
        archive_bytes = stream.getvalue()
        archive_path = directory/(role+'.tar.gz'); preserve_bytes(archive_path, archive_bytes)
        value = {'schema': 'kamui.host-install.v1', 'role': role, 'archiveSha256': sha(archive_bytes),
                 'files': pins, 'releaseImages': manifest['images'], 'compose': {'version': COMPOSE_VERSION, 'sha256': COMPOSE_SHA}}
        data = (json.dumps(value, indent=2)+'\n').encode()
        manifest_path = directory/(role+'-manifest.json'); preserve_bytes(manifest_path, data)
        artifacts['roles'][role] = {'archive': {'path': str(archive_path), 'sha256': sha(archive_bytes)},
                                   'manifest': {'path': str(manifest_path), 'sha256': sha(data)}}
    committed_source(revision, repo)
    target = directory/'package.json'
    if target.exists():
        if json.loads(read_private(target)) != artifacts: raise ValueError('INSTALL_PACKAGE_CHANGED')
    else: write_private(target, artifacts)
    return artifacts


RUNTIME_DERIVED = ('backend/backend.public.env', 'backend/keychain.public.env', 'backend/watcher.public.env', 'manifest.json')
SUPERSEDED_NAME = re.compile(r'[0-9]{3}-[0-9a-f]{12}')


def superseded(root):
    """Completed supersessions, oldest first. An unfinished one blocks every other step."""
    archive = Path(root)/'installation/superseded'
    if not archive.exists(): return []
    done = []
    for entry in sorted(archive.iterdir()):
        if not SUPERSEDED_NAME.fullmatch(entry.name) or entry.is_symlink() or not entry.is_dir(): raise ValueError('SUPERSEDED_STATE_UNEXPECTED')
        if not (entry/'complete.json').exists(): raise ValueError('SUPERSEDE_UNFINISHED_RERUN_SUPERSEDE')
        record = json.loads(read_private(entry/'superseded.json'))
        if json.loads(read_private(entry/'complete.json')) != record: raise ValueError('SUPERSEDED_STATE_UNEXPECTED')
        done.append(record)
    return done


def supersede(root):
    """Archive a completed, never-started release so 07-10 can build and install the next one.

    Hosts still refuse the replacement unless their receipt shows the wallet never started and
    no wallet state exists. Generated database secrets are kept; only derived public runtime
    files are archived so script 08 rewrites them from the current source.
    """
    installation = Path(root)/'installation'
    archive = private_dir(installation/'superseded')
    entries = sorted(archive.iterdir())
    if any(not SUPERSEDED_NAME.fullmatch(e.name) or e.is_symlink() or not e.is_dir() for e in entries):
        raise ValueError('SUPERSEDED_STATE_UNEXPECTED')
    pending = [e for e in entries if not (e/'complete.json').exists()]
    if len(pending) > 1: raise ValueError('SUPERSEDED_STATE_UNEXPECTED')
    if pending:
        target = pending[0]
        if not (target/'superseded.json').exists(): raise ValueError('SUPERSEDED_STATE_UNEXPECTED')
        record = json.loads(read_private(target/'superseded.json'))
    else:
        release = installation/'release'/'release.json'
        if not release.exists(): raise ValueError('SUPERSEDE_REQUIRES_COMPLETED_RELEASE')
        raw = read_private(release)
        revision = json.loads(raw).get('sourceRevision', '')
        if not isinstance(revision, str) or not re.fullmatch('[a-f0-9]{40}', revision): raise ValueError('INSTALL_SOURCE_REVISION_REQUIRED')
        target = archive/f'{len(entries)+1:03d}-{revision[:12]}'
        os.mkdir(target, 0o700); base.sync(archive)
        record = {'schema': 'kamui.superseded-release.v1', 'sourceRevision': revision, 'releaseSha256': sha(raw)}
        write_private(target/'superseded.json', record)
    # Each move is idempotent, so an interrupted run resumes instead of guessing.
    moves = [(installation/'release', target/'release'), (installation/'package', target/'package')]
    moves += [(installation/'runtime'/name, target/('runtime-'+name.replace('/', '-'))) for name in RUNTIME_DERIVED]
    for source, destination in moves:
        if source.is_symlink() or destination.is_symlink(): raise ValueError('SUPERSEDE_SYMLINK_REFUSED')
        if source.exists():
            if destination.exists(): raise ValueError('SUPERSEDED_STATE_UNEXPECTED')
            os.rename(source, destination)
            base.sync(source.parent); base.sync(target)
    if (target/'release'/'release.json').exists() is False: raise ValueError('SUPERSEDED_STATE_UNEXPECTED')
    if sha(read_private(target/'release'/'release.json')) != record['releaseSha256']: raise ValueError('SUPERSEDED_STATE_UNEXPECTED')
    write_private(target/'complete.json', record)
    return {'superseded': target.name, 'sourceRevision': record['sourceRevision'],
            'nextSteps': ['07-build-release', '08-prepare-runtime', '09-install-hosts', '10-verify-installation'],
            'walletStarted': False}


def bootstrap(role, bucket, artifacts, verify=False, replace=False):
    if role not in ROLES or not re.fullmatch('[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', bucket):
        raise ValueError('INSTALL_BOOTSTRAP_INPUT_INVALID')
    if verify and replace: raise ValueError('INSTALL_VERIFY_CANNOT_REPLACE')
    q = shlex.quote
    selected = {'host-install.py': artifacts['installer'], 'pull-images.py': artifacts['puller'], 'compose-linux-x86_64': artifacts['compose'],
                role+'.tar.gz': artifacts['roles'][role]['archive'], role+'-manifest.json': artifacts['roles'][role]['manifest']}
    lines = ['set -eu', 'umask 077', '[ "$(id -u)" = 0 ]',
             # AL2023 ships Python 3.9; platform.freedesktop_os_release() needs 3.10.
             "python3 -c \"import platform,shlex; v={k:(shlex.split(x) or [''])[0] for k,_,x in (l.partition('=') for l in open('/etc/os-release'))}; assert v.get('ID')=='amzn' and v.get('VERSION_ID')=='2023' and platform.machine()=='x86_64'\"",
             'log=/var/log/kamui-public-install-'+role+'-'+artifacts['roles'][role]['manifest']['sha256'][:16]+'.log',
             '[ ! -L "$log" ]', 'touch "$log"', 'chmod 600 "$log"',
             'work=$(mktemp -d /var/tmp/kamui-public-install.XXXXXX)', 'trap \'rm -rf "$work"\' EXIT']
    child = ['work=$1',
             'unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE AWS_DEFAULT_PROFILE AWS_ROLE_ARN AWS_WEB_IDENTITY_TOKEN_FILE AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONTAINER_CREDENTIALS_FULL_URI AWS_ENDPOINT_URL || true',
             'export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true AWS_MAX_ATTEMPTS=1 AWS_EC2_METADATA_DISABLED=false',
             ("command -v aws >/dev/null 2>&1" if verify else "if ! command -v aws >/dev/null 2>&1; then dnf -y install awscli-2; fi"),
             "aws --version 2>&1 | grep '^aws-cli/2\\.' >/dev/null"]
    for name, artifact in selected.items():
        digest = artifact['sha256']
        if not re.fullmatch('[a-f0-9]{64}', digest): raise ValueError('INSTALL_BOOTSTRAP_HASH_INVALID')
        uri = f's3://{bucket}/installation/{digest}/{name}'
        child += ['aws s3 cp '+q(uri)+' "$work/'+name+'" --region eu-west-1 --only-show-errors',
                  "printf '%s  %s\\n' "+q(digest)+' "$work/'+name+'" | sha256sum -c - >/dev/null']
    command = 'python3 "$work/host-install.py" --role '+q(role)+' --archive "$work/'+role+'.tar.gz" --manifest "$work/'+role+'-manifest.json" --manifest-sha256 '+q(artifacts['roles'][role]['manifest']['sha256'])
    command += ' --compose-binary "$work/compose-linux-x86_64" --compose-sha256 '+q(COMPOSE_SHA)
    if verify: command += ' --check'
    # Only after an explicit supersede; the host still refuses a started wallet or any wallet state.
    if replace: command += ' --replace-unstarted'
    image_command = 'python3 "$work/pull-images.py" --role '+q(role)+' --manifest "$work/'+role+'-manifest.json" --manifest-sha256 '+q(artifacts['roles'][role]['manifest']['sha256'])+' --docker-config "$work/docker-auth"'
    if verify: image_command += ' --check'
    child += [command, image_command]
    # A separate shell is essential: `set -e` inside `( ... ) || handler`
    # can be ignored by POSIX shells, permitting execution after a bad checksum.
    lines += ['if /bin/sh -eu -c '+q('\n'.join(child))+' kamui-public-install "$work" >>"$log" 2>&1; then',
              'echo KAMUI_PUBLIC_PACKAGE_'+('VERIFIED' if verify else 'INSTALLED')+'_RUNTIME_PENDING',
              'else', 'echo KAMUI_PUBLIC_INSTALL_FAILED_SEE_PRIVATE_HOST_LOG', 'exit 1', 'fi']
    return '\n'.join(lines)+'\n'


def deliver(root, aws, driver, verify=False):
    manifest = json.loads(read_private(Path(root)/'installation/release/release.json'))
    artifacts = package(root, manifest)
    bucket = manifest['releaseBucketName']; config = driver.config
    selected = [artifacts['installer'], artifacts['puller'], artifacts['compose']]
    for role in ROLES: selected += list(artifacts['roles'][role].values())
    if not verify:
        for artifact in selected:
            path = Path(artifact['path'])
            aws.put_public_file(config['backend']['aws_profile'], bucket, config['backend']['expected_account'],
                                'installation/'+artifact['sha256']+'/'+path.name, path)
    replace = not verify and bool(superseded(root))
    for role in ROLES:
        target = driver.target(role)
        driver.command(role, 'verify' if verify else 'install', target['InstanceId'], bootstrap(role, bucket, artifacts, verify, replace))
    return {'publicPackageInstalled': True, 'verificationRequested': verify, 'runtimeDelivered': False, 'walletStarted': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('step', choices=['supersede', 'release', 'runtime', 'install', 'verify'])
    parser.add_argument('--private-directory', default=str(Path.home()/'.kamui-hosting-sepolia'))
    parser.add_argument('--allow-local-tool-fixes', action='store_true', help='Resume an existing frozen release using logged helper-only local fixes')
    options = parser.parse_args()
    if options.allow_local_tool_fixes and options.step!='release':raise ValueError('LOCAL_TOOL_FIXES_RELEASE_ONLY')
    root = private_dir(options.private_directory)
    directory = private_dir(root/'installation')
    descriptor = os.open(directory/'.installation.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print('STEP_'+options.step.upper(), flush=True)
        if options.step == 'supersede':
            print(json.dumps(supersede(root))); return
        superseded(root)  # an interrupted supersede must be finished first
        if options.step == 'runtime':
            print(json.dumps(load('runtime').prepare(root))); return
        aws = Aws(root); driver = Driver(root, aws)
        if options.step == 'release':
            release = load('release').Release(root, aws, allow_local_tools=options.allow_local_tool_fixes)
            release.prepare_resources(driver.stack); release.build_publish()
            print('IMMUTABLE_RELEASE_PUBLISHED_REVIEW_STILL_REQUIRED')
        else: print(json.dumps(deliver(root, aws, driver, options.step == 'verify')))
    finally: os.close(descriptor)


if __name__ == '__main__':
    try: main()
    except Exception as error:
        code = str(error) if isinstance(error, (ValueError, AwsError)) and re.fullmatch('[A-Z_]{3,100}', str(error)) else 'INSTALL_STOPPED_PRIVATE_EVIDENCE_RETAINED'
        print(code); raise SystemExit(1)
