#!/usr/bin/env python3
"""Root-only. Fetch this host's runtime files from AWS Secrets Manager into /etc/kamui.

Runs before every stack start (kamui-secrets@<role>.service). It uses the instance role, which is
the only principal allowed to read these secrets. Owners and modes come from this file, never from
the secret, so a stored bundle cannot loosen them. No value is ever printed or logged: output names
files, versions and a status only.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import uuid

REGION = 'eu-west-1'
# Must match runtime.py ownership(); a workstation test keeps the two in step.
FILES = {
    'backend': {
        'secrets/POSTGRES_PASSWORD': (999, 999, 0o400),
        'secrets/APP_DATABASE_PASSWORD': (999, 999, 0o400),
        'backup/pgbackrest.conf': (999, 999, 0o400),
        'secrets/DATABASE_URL': (1000, 1000, 0o400),
        'funding-policy.json': (1000, 1000, 0o400),
        'secrets/OPERATOR_DATABASE_URL': (0, 0, 0o400),
        'backend.public.env': (0, 0, 0o600),
        'keychain.public.env': (0, 0, 0o600),
        'watcher.public.env': (0, 0, 0o600),
        'backup/operator.settings': (0, 0, 0o600),
    },
    'pepper': {'pepper.private.env': (0, 0, 0o600)},
}
RELAYER = ('secrets/RELAYER_PRIVATE_KEY', (1000, 1000, 0o400))
SCHEMA = 'kamui.runtime-bundle.v1'
MAX_FILE = 65536


def secret_ids(role):
    ids = {'runtime': 'kamui-sepolia/'+role+'/runtime'}
    if role == 'backend': ids['relayer'] = 'kamui-sepolia/backend/relayer-private-key'
    return ids


def aws_fetch(secret_id):
    """The instance role only: static credentials and profiles are removed from the environment."""
    environment = {k: v for k, v in os.environ.items() if not k.startswith('AWS_')}
    environment.update(AWS_CONFIG_FILE='/dev/null', AWS_SHARED_CREDENTIALS_FILE='/dev/null',
                       AWS_EC2_METADATA_DISABLED='false', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS='true',
                       AWS_MAX_ATTEMPTS='3', AWS_DEFAULT_REGION=REGION, AWS_PAGER='')
    try:
        answer = subprocess.run(['aws', 'secretsmanager', 'get-secret-value', '--secret-id', secret_id,
                                 '--region', REGION, '--output', 'json', '--no-cli-pager'],
                                capture_output=True, env=environment, timeout=60)
    except Exception:
        raise ValueError('SECRET_FETCH_FAILED') from None
    # stderr can name the secret but never holds its value; neither stream is printed.
    if answer.returncode: raise ValueError('SECRET_FETCH_FAILED')
    try: value = json.loads(answer.stdout)
    except Exception: raise ValueError('SECRET_RESPONSE_INVALID') from None
    if not isinstance(value.get('SecretString'), str) or not isinstance(value.get('VersionId'), str):
        raise ValueError('SECRET_RESPONSE_INVALID')
    return value['SecretString'], value['VersionId']


def parse_bundle(text, role):
    try: bundle = json.loads(text)
    except Exception: raise ValueError('RUNTIME_BUNDLE_NOT_SET') from None
    if not isinstance(bundle, dict) or bundle.get('schema') != SCHEMA or bundle.get('role') != role:
        raise ValueError('RUNTIME_BUNDLE_NOT_SET')
    files = bundle.get('files')
    if not isinstance(files, dict) or set(files) != set(FILES[role]):
        raise ValueError('RUNTIME_BUNDLE_FILES_UNEXPECTED')
    result = {}
    for path, entry in files.items():
        if not isinstance(entry, dict) or set(entry) != {'content', 'sha256'} or not isinstance(entry['content'], str):
            raise ValueError('RUNTIME_BUNDLE_ENTRY_INVALID')
        data = entry['content'].encode()
        if len(data) > MAX_FILE or b'\0' in data or hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise ValueError('RUNTIME_BUNDLE_ENTRY_INVALID')
        result[path] = data
    return result


def parse_relayer(text):
    value = text.strip()
    # A CloudFormation placeholder or anything else that is not a Starknet private key is refused.
    if not re.fullmatch(r'0x[0-9a-fA-F]{1,64}', value): raise ValueError('RELAYER_KEY_NOT_SET')
    return (value+'\n').encode()


def place(root, relative, data, owner, chown=os.fchown):
    """Atomic, exact owner and mode; refuses links and anything that is not a regular file."""
    uid, gid, mode = owner
    target = root/'etc/kamui'/relative
    parent = target.parent
    info = parent.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode): raise ValueError('RUNTIME_DIRECTORY_UNTRUSTED')
    if target.is_symlink(): raise ValueError('RUNTIME_FILE_LINK_REFUSED')
    if target.exists():
        current = target.lstat()
        if not stat.S_ISREG(current.st_mode) or current.st_nlink != 1: raise ValueError('RUNTIME_FILE_UNTRUSTED')
        if (current.st_uid, current.st_gid, stat.S_IMODE(current.st_mode)) == (uid, gid, mode) and target.read_bytes() == data:
            return False
    temporary = parent/('.'+target.name+'.'+uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        chown(fd, uid, gid)
        os.fchmod(fd, mode)
        os.write(fd, data); os.fsync(fd)
    finally: os.close(fd)
    try: os.rename(temporary, target)
    finally:
        if temporary.exists(): temporary.unlink()
    directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(directory)
    finally: os.close(directory)
    return True


def sync(role, fetch=aws_fetch, root=Path('/'), chown=os.fchown):
    if role not in FILES: raise ValueError('ROLE_INVALID')
    ids = secret_ids(role)
    text, runtime_version = fetch(ids['runtime'])
    files = parse_bundle(text, role)
    owners = dict(FILES[role])
    relayer_version = None
    if 'relayer' in ids:
        key, relayer_version = fetch(ids['relayer'])
        files[RELAYER[0]] = parse_relayer(key)
        owners[RELAYER[0]] = RELAYER[1]
    # Validate everything before writing anything, so a bad version never half-replaces the set.
    written = sum(place(root, path, files[path], owners[path], chown) for path in sorted(files))
    return {'status': 'runtime_files_current', 'role': role, 'runtimeVersion': runtime_version,
            'relayerVersion': relayer_version, 'filesWritten': written, 'files': len(files)}


if __name__ == '__main__':
    try:
        if os.geteuid() != 0: raise ValueError('ROOT_REQUIRED')
        if len(sys.argv) != 2: raise ValueError('ROLE_REQUIRED')
        print(json.dumps(sync(sys.argv[1])))
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch('[A-Z_]{3,100}', str(error)) else 'RUNTIME_SYNC_FAILED'
        print(code); raise SystemExit(1)
