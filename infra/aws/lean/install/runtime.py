#!/usr/bin/env python3
"""Private runtime files only. No AWS calls, secret upload, signing or service startup."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
RPC = 'https://api.zan.top/public/starknet-sepolia/rpc/v0_10'
KEYCHAIN = 'https://sepolia.kamui.page'
PEPPER = 'https://pepper-sepolia.kamui.page'
FIELD = (1 << 251) + 17 * (1 << 192) + 1
CLASS = '0x1e128dae2cb709cac9263afa1c6fdb33f7f1f5c2d969547d9739326d08399f6'
REGISTRY = '0x4bc2b2afcce053e788511a851e6aeb004d18adb243df4fe852e1b727bd09808'
EXECUTOR = '0x44c921502db6c924a29f78256d72926060efa599cd13d97142efa192eaebd4c'
MANAGED_FILES = {'backend': {'backend.public.env', 'keychain.public.env', 'watcher.public.env',
    'funding-policy.json', 'backup/pgbackrest.conf', 'backup/operator.settings',
    'secrets/POSTGRES_PASSWORD', 'secrets/APP_DATABASE_PASSWORD', 'secrets/DATABASE_URL', 'secrets/OPERATOR_DATABASE_URL'},
    'pepper': {'pepper.private.env'}}


def ownership(relative):
    uid = 999 if relative in {'secrets/POSTGRES_PASSWORD', 'secrets/APP_DATABASE_PASSWORD', 'backup/pgbackrest.conf'} else 1000 if relative in {'secrets/DATABASE_URL', 'funding-policy.json'} else 0
    mode = '0400' if relative.startswith('secrets/') or relative in {'funding-policy.json', 'backup/pgbackrest.conf'} else '0600'
    return uid, uid, mode


def directory(path):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path:
        raise ValueError('PRIVATE_RUNTIME_DIRECTORY_REQUIRED')
    path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('PRIVATE_RUNTIME_DIRECTORY_REQUIRED')
    return path


def read(path, private=True):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() or (private and info.st_mode & 0o077) or info.st_size > 262144:
            raise ValueError('RUNTIME_SOURCE_FILE_INVALID')
        value = os.read(fd, 262145)
        if len(value) > 262144: raise ValueError('RUNTIME_SOURCE_FILE_INVALID')
        return value
    finally:
        os.close(fd)


def write(path, value):
    """Exclusive durable write, or verify identical prior content; never replace."""
    path = Path(path)
    data = value.encode() if isinstance(value, str) else value
    if path.exists() or path.is_symlink():
        if read(path) != data: raise ValueError('RUNTIME_EXISTING_FILE_CHANGED')
        return
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as output:
        output.write(data); output.flush(); os.fsync(output.fileno())
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, indent=2)+'\n').encode()


def fields(path, allowed, private=True):
    """Read allowlisted literals only. Never source/eval/substitute shell text."""
    result = {}
    for line in read(path, private).decode().splitlines():
        match = re.fullmatch(r'\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*', line)
        if not match or match[1] not in allowed:
            continue
        name, value = match.groups()
        if name in result: raise ValueError('RUNTIME_DUPLICATE_SOURCE_FIELD')
        if value[:1] in ('"', "'"):
            if len(value) < 2 or value[-1] != value[0]: raise ValueError('RUNTIME_SOURCE_LITERAL_REQUIRED')
            value = value[1:-1]
        if any(c in value for c in ['\n', '\r', '\x00', '`', '$', '\\']):
            raise ValueError('RUNTIME_SOURCE_LITERAL_REQUIRED')
        result[name] = value
    return result


def load_metadata(root, source_paths=None):
    source_paths = source_paths or {}
    backend = fields(Path(source_paths.get('backend_env', REPO/'services/backend/.env.local')),
                     {'AUTHORIZED_GOOGLE_RECOVERY_CLIENT_ID', 'RELAYER_ADDRESS'})
    pepper = fields(Path(source_paths.get('pepper_env', REPO/'services/pepper/.env.local')),
                    {'KMS_KEY_ID', 'PEPPER_KEY_CHECK', 'GOOGLE_AUDIENCES'})
    deployments = fields(Path(source_paths.get('deployments', REPO/'services/backend/deployments.env')),
                         {'KAMUI_ACCOUNT_CLASS_HASH', 'SN_SEPOLIA_REGISTRY_ADDRESS', 'SN_SEPOLIA_REGISTRY_BLOCK', 'PROVER_EXECUTOR_ADDRESS'}, private=False)
    selected = json.loads(read(Path(root)/'aws-input.json'))
    return {'googleClientId': backend.get('AUTHORIZED_GOOGLE_RECOVERY_CLIENT_ID', ''),
            'relayerAddress': backend.get('RELAYER_ADDRESS', ''),
            'classHash': deployments.get('KAMUI_ACCOUNT_CLASS_HASH', ''),
            'registryAddress': deployments.get('SN_SEPOLIA_REGISTRY_ADDRESS', ''),
            'registryBlock': deployments.get('SN_SEPOLIA_REGISTRY_BLOCK', ''),
            'executorAddress': deployments.get('PROVER_EXECUTOR_ADDRESS', ''),
            'pepperKeyArn': pepper.get('KMS_KEY_ID', ''),
            'pepperKeyCheck': pepper.get('PEPPER_KEY_CHECK', ''),
            'pepperAudiences': pepper.get('GOOGLE_AUDIENCES', ''),
            'selectedPepperKeyArn': selected['pepper']['pepper_key_id'],
            'backupBucket': selected['backend']['backup_bucket']}


def validate_metadata(data):
    required = {'googleClientId', 'relayerAddress', 'classHash', 'registryAddress', 'registryBlock',
                'executorAddress', 'pepperKeyArn', 'pepperKeyCheck', 'pepperAudiences', 'selectedPepperKeyArn', 'backupBucket'}
    if not isinstance(data, dict) or set(data) != required or not all(isinstance(x, str) for x in data.values()):
        raise ValueError('RUNTIME_METADATA_INVALID')
    if not re.fullmatch(r'[A-Za-z0-9._-]+\.apps\.googleusercontent\.com', data['googleClientId']):
        raise ValueError('RUNTIME_GOOGLE_CLIENT_REQUIRED')
    if not re.fullmatch(r'0x[0-9a-fA-F]{1,63}', data['relayerAddress']) or not 0 < int(data['relayerAddress'], 16) < FIELD:
        raise ValueError('RUNTIME_RELAYER_REQUIRED')
    if (data['classHash'], data['registryAddress'], data['executorAddress']) != (CLASS, REGISTRY, EXECUTOR):
        raise ValueError('RUNTIME_PUBLIC_PIN_MISMATCH')
    if not re.fullmatch(r'[1-9][0-9]{0,9}', data['registryBlock']): raise ValueError('RUNTIME_REGISTRY_BLOCK_REQUIRED')
    if not re.fullmatch(r'arn:aws:kms:eu-west-1:[0-9]{12}:key/[A-Za-z0-9-]+', data['pepperKeyArn']) or data['pepperKeyArn'] != data['selectedPepperKeyArn']:
        raise ValueError('RUNTIME_EXISTING_PEPPER_KEY_MISMATCH')
    if not re.fullmatch(r'[0-9a-f]{16}', data['pepperKeyCheck']): raise ValueError('RUNTIME_PEPPER_CHECK_REQUIRED')
    audiences = data['pepperAudiences'].split(',')
    if data['googleClientId'] not in audiences or any(not re.fullmatch(r'[A-Za-z0-9._-]+\.apps\.googleusercontent\.com', value) for value in audiences):
        raise ValueError('RUNTIME_GOOGLE_AUDIENCE_MISMATCH')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', data['backupBucket']): raise ValueError('RUNTIME_BACKUP_BUCKET_REQUIRED')


def env_bytes(values):
    if any(not isinstance(v, str) or any(c in v for c in ['\n', '\r', '\x00', '$', '`', '\\']) for v in values.values()):
        raise ValueError('RUNTIME_ENV_LITERAL_REQUIRED')
    return ''.join(k+'='+v+'\n' for k,v in values.items()).encode()


def prepare(root, metadata=None, source_paths=None):
    root = directory(root)
    target = directory(directory(root/'installation')/'runtime')
    backend = directory(target/'backend'); pepper = directory(target/'pepper')
    secret_dir = directory(backend/'secrets'); backup = directory(backend/'backup')
    directory(backend/'operator')
    data = metadata if metadata is not None else load_metadata(root, source_paths)
    validate_metadata(data)
    write(target/'source-pins.json', json_bytes(data))
    for name in ['POSTGRES_PASSWORD', 'APP_DATABASE_PASSWORD']:
        path = secret_dir/name
        if path.exists() or path.is_symlink():
            if not re.fullmatch(rb'[A-Za-z0-9_-]{64}\n', read(path)): raise ValueError('RUNTIME_PASSWORD_STATE_INVALID')
        else:
            write(path, secrets.token_urlsafe(48)+'\n')
    app = read(secret_dir/'APP_DATABASE_PASSWORD').decode().strip()
    url = 'postgresql://kamui:'+app+'@postgres:5432/kamui\n'
    write(secret_dir/'DATABASE_URL', url)
    write(secret_dir/'OPERATOR_DATABASE_URL', url)
    write(backend/'backend.public.env', env_bytes({'CHAIN_ID': 'SN_SEPOLIA', 'RPC_URL': RPC,
        'KAMUI_ACCOUNT_CLASS_HASH': CLASS, 'AUTHORIZED_GOOGLE_RECOVERY_CLIENT_ID': data['googleClientId'],
        'RELAYER_ADDRESS': data['relayerAddress'], 'PEPPER_SERVICE_URL': PEPPER,
        'DEPLOYS_PER_HOUR': '0', 'SPONSORED_PER_HOUR': '0'}))
    write(backend/'keychain.public.env', env_bytes({'GOOGLE_CLIENT_ID': data['googleClientId'],
        'KAMUI_ACCOUNT_CLASS_HASH': CLASS, 'PROVER_EXECUTOR_ADDRESS': EXECUTOR, 'JWK_REGISTRY_ADDRESS': REGISTRY, 'PUBLIC_RPC_URL': RPC}))
    write(backend/'watcher.public.env', env_bytes({'CHAIN_ID': 'SN_SEPOLIA', 'RPC_URL': RPC,
        'SN_SEPOLIA_REGISTRY_ADDRESS': REGISTRY, 'SN_SEPOLIA_REGISTRY_BLOCK': data['registryBlock'],
        'WATCHER_POLL_SECONDS': '60', 'WATCHER_WEBHOOK_URL': ''}))
    write(pepper/'pepper.private.env', env_bytes({'KMS_KEY_ID': data['pepperKeyArn'], 'PEPPER_KEY_CHECK': data['pepperKeyCheck'],
        'GOOGLE_AUDIENCES': data['googleClientId'], 'RATE_IP_BURST': '30', 'RATE_IP_PER_MINUTE': '30',
        'RATE_SUBJECT_BURST': '10', 'RATE_SUBJECT_PER_HOUR': '10'}))
    policy = json.loads((REPO/'services/backend/funding-policy.example.json').read_text())
    if policy.get('apps') or policy.get('allowExternalPaymaster') is not False: raise ValueError('RUNTIME_ZERO_POLICY_REQUIRED')
    for limits in [policy.get('global', {})] + list(policy.get('operations', {}).values()):
        if any(value not in (0, '0') for key,value in limits.items() if key != 'periodSeconds'): raise ValueError('RUNTIME_ZERO_POLICY_REQUIRED')
    write(backend/'funding-policy.json', json_bytes(policy))
    pgbackrest = (HERE.parent/'backup/pgbackrest.conf.example').read_text().replace('REPLACE_WITH_REVIEWED_PRIVATE_BUCKET', data['backupBucket'])
    write(backup/'pgbackrest.conf', pgbackrest)
    # Explicit review acknowledgements stay empty; never auto-enable backup jobs.
    write(backup/'operator.settings', (HERE.parent/'backup/operator.settings.example').read_text())
    mapping = target/'existing-secret-files.json'
    if not mapping.exists(): write(mapping, json_bytes({'version': 1, 'backend': {'RELAYER_PRIVATE_KEY': None}}))
    entries = []
    for role in ['backend', 'pepper']:
        for path in (target/role).rglob('*'):
            if (path.is_file() or path.is_symlink()) and path.relative_to(target/role).as_posix() not in MANAGED_FILES[role]:
                raise ValueError('RUNTIME_UNEXPECTED_FILE_NOT_BUNDLED')
        for relative in sorted(MANAGED_FILES[role]):
            path = target/role/relative
            uid, gid, mode = ownership(relative)
            entries.append({'role': role, 'path': relative, 'uid': uid, 'gid': gid, 'mode': mode,
                            'sha256': hashlib.sha256(read(path)).hexdigest()})
    manifest = {'version': 1, 'containsGeneratedDatabaseSecrets': True, 'publicPackageAllowed': False,
                'automaticSecretUploadAllowed': False, 'entries': entries,
                'requiredExternalFiles': [{'role': 'backend', 'path': 'secrets/RELAYER_PRIVATE_KEY', 'uid': 1000, 'gid': 1000, 'mode': '0400'}]}
    write(target/'manifest.json', json_bytes(manifest))
    return validate(root)


def validate(root, require_external=False):
    target = Path(root)/'installation/runtime'
    manifest = json.loads(read(target/'manifest.json'))
    if not isinstance(manifest, dict) or set(manifest) != {'version', 'containsGeneratedDatabaseSecrets', 'publicPackageAllowed', 'automaticSecretUploadAllowed', 'entries', 'requiredExternalFiles'} or manifest.get('version') != 1 or manifest.get('containsGeneratedDatabaseSecrets') is not True or manifest.get('publicPackageAllowed') is not False or manifest.get('automaticSecretUploadAllowed') is not False or not isinstance(manifest.get('entries'), list):
        raise ValueError('RUNTIME_MANIFEST_INVALID')
    validate_metadata(json.loads(read(target/'source-pins.json')))
    paths = set()
    for entry in manifest.get('entries', []):
        if not isinstance(entry, dict) or set(entry) != {'role', 'path', 'uid', 'gid', 'mode', 'sha256'}: raise ValueError('RUNTIME_MANIFEST_INVALID')
        if entry.get('role') not in MANAGED_FILES or entry.get('path') not in MANAGED_FILES[entry['role']]: raise ValueError('RUNTIME_MANIFEST_INVALID')
        if (entry['uid'], entry['gid'], entry['mode']) != ownership(entry['path']): raise ValueError('RUNTIME_MANIFEST_INVALID')
        relative = Path(entry['path'])
        if entry['role'] not in {'backend', 'pepper'} or relative.is_absolute() or '..' in relative.parts or (entry['role'], entry['path']) in paths:
            raise ValueError('RUNTIME_MANIFEST_INVALID')
        paths.add((entry['role'], entry['path']))
        if hashlib.sha256(read(target/entry['role']/relative)).hexdigest() != entry['sha256']:
            raise ValueError('RUNTIME_FILE_CHANGED')
    if paths != {(role, name) for role, names in MANAGED_FILES.items() for name in names}: raise ValueError('RUNTIME_MANIFEST_INVALID')
    if manifest.get('requiredExternalFiles') != [{'role': 'backend', 'path': 'secrets/RELAYER_PRIVATE_KEY', 'uid': 1000, 'gid': 1000, 'mode': '0400'}]: raise ValueError('RUNTIME_MANIFEST_INVALID')
    mapping = json.loads(read(target/'existing-secret-files.json'))
    if set(mapping) != {'version', 'backend'} or mapping.get('version') != 1 or set(mapping.get('backend', {})) != {'RELAYER_PRIVATE_KEY'}:
        raise ValueError('RUNTIME_EXTERNAL_FILE_MAPPING_INVALID')
    key_path = mapping['backend']['RELAYER_PRIVATE_KEY']
    pending = key_path is None
    if key_path is not None:
        # Validate metadata only. The signer value is never read/copy/uploaded here.
        if not isinstance(key_path, str) or not Path(key_path).is_absolute() or Path(key_path).resolve() != Path(key_path):
            raise ValueError('RUNTIME_EXTERNAL_FILE_PATH_REQUIRED')
        info = Path(key_path).lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or info.st_mode & 0o077 or not 0 < info.st_size < 4096:
            raise ValueError('RUNTIME_EXTERNAL_FILE_PRIVATE_REQUIRED')
    if require_external and pending: raise ValueError('RUNTIME_RELAYER_DELIVERY_REQUIRED')
    return {'status': 'private_runtime_prepared', 'files': len(paths), 'externalRelayerSourcePending': pending,
            'externalSigningKeyReadOrUploaded': False, 'externalSourceValidatedByMetadataOnly': True, 'generatedDatabaseSecrets': True, 'servicesStarted': False,
            'startupReady': False, 'remainingGates': ['private_runtime_delivery', 'registry_role_handoff', 'restore_gate_and_schema', 'backup_restore_and_alert_review', 'explicit_startup']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'validate'])
    parser.add_argument('--private-directory', default=str(Path.home()/'.kamui-hosting-sepolia'))
    parser.add_argument('--require-external-source', action='store_true')
    args = parser.parse_args()
    result = prepare(args.private_directory) if args.action == 'prepare' else validate(args.private_directory, args.require_external_source)
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try: main()
    except Exception:
        print('PRIVATE_RUNTIME_PREPARATION_REFUSED'); raise SystemExit(1)
