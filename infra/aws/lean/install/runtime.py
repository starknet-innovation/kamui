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
import uuid

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
# SNF's public Sepolia node first; ZAN only when it cannot serve a request (no SLA).
RPC = 'https://sepolia.nodes.starknet.org/rpc/v0_10'
RPC_FALLBACK = 'https://api.zan.top/public/starknet-sepolia/rpc/v0_10'
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
        if private and info.st_mode & 0o077:
            raise ValueError('RUNTIME_PRIVATE_SOURCE_PERMISSIONS_REQUIRED')
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() or info.st_size > 262144:
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


# Derived from reviewed inputs rather than generated, so they may be regenerated when an input
# changes (an operator decision, an RPC endpoint). Generated passwords and the database URLs built
# from them stay write-once: replacing one would silently lock the running database out.
DERIVED = {'backend.public.env', 'keychain.public.env', 'watcher.public.env', 'backup/operator.settings', 'backup/pgbackrest.conf',
           'funding-policy.json'}
FRI_MAX = 2**256 - 1
FUNDING_LIMIT_KEYS = {'periodSeconds', 'txPerPeriod', 'perAccountPerPeriod', 'maxFeePerTx', 'maxFeePerPeriod', 'perAccountMaxFeePerPeriod'}
FUNDING_OPERATIONS = {'sponsor', 'deployment', 'recovery', 'wallet'}
APP_KEY = re.compile(r'[A-Za-z0-9_-]{16,64}')  # services/backend/src/services/sponsor/funding.ts keyPattern
EMPTY_SHA256 = hashlib.sha256(b'').hexdigest()
DECISIONS = 'runtime-decisions.json'
WEBHOOK = re.compile(r"https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:/[A-Za-z0-9._~%!*'()+,;=:@/-]*)?(?:\?[A-Za-z0-9._~%!*'()+,;=:@/?&-]*)?")


def update(path, value, history, label):
    """Replace a derived file atomically, keeping the previous version privately as evidence."""
    path = Path(path)
    data = value.encode() if isinstance(value, str) else value
    if path.exists() or path.is_symlink():
        current = read(path)
        if current == data: return False
        keep = directory(history)/(label+'-'+hashlib.sha256(current).hexdigest()[:16])
        if keep.exists() or keep.is_symlink():
            if read(keep) != current: raise ValueError('RUNTIME_HISTORY_CONFLICT')
        else: write(keep, current)
    temporary = path.parent/('.'+path.name+'.'+uuid.uuid4().hex)
    write(temporary, data)
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)
    return True


def load_decisions(root):
    """Optional private operator decisions. Absent means every decision is still open."""
    path = Path(root)/'installation'/DECISIONS
    if not path.exists() and not path.is_symlink(): return {}
    try: value = json.loads(read(path))
    except ValueError as error:
        if str(error).startswith('RUNTIME_'): raise
        raise ValueError('RUNTIME_DECISIONS_INVALID') from None
    validate_decisions(value)
    return value


def validate_decisions(value):
    if not isinstance(value, dict) or value.get('version') != 1 or set(value) - {'version', 'backup', 'alerts', 'funding'}:
        raise ValueError('RUNTIME_DECISIONS_INVALID')
    backup, alerts = value.get('backup', {}), value.get('alerts', {})
    if not isinstance(backup, dict) or set(backup) - {'reviewed', 'retentionApproved', 'retentionFullDays', 'maxSuccessfulBackupAgeSeconds'}:
        raise ValueError('RUNTIME_DECISIONS_INVALID')
    if any(key in backup and not isinstance(backup[key], bool) for key in ['reviewed', 'retentionApproved']):
        raise ValueError('RUNTIME_DECISIONS_INVALID')
    # Approving retention is only meaningful on top of the backup review itself.
    if backup.get('retentionApproved') and not backup.get('reviewed'): raise ValueError('RUNTIME_RETENTION_NEEDS_REVIEW')
    days = backup.get('retentionFullDays', 7)
    if type(days) is not int or not 1 <= days <= 365: raise ValueError('RUNTIME_RETENTION_DAYS_INVALID')
    age = backup.get('maxSuccessfulBackupAgeSeconds')
    if age is not None and (type(age) is not int or not 3600 <= age <= 2592000): raise ValueError('RUNTIME_BACKUP_AGE_INVALID')
    if not isinstance(alerts, dict) or set(alerts) - {'watcherWebhookUrl'}: raise ValueError('RUNTIME_DECISIONS_INVALID')
    url = alerts.get('watcherWebhookUrl', '')
    if not isinstance(url, str) or (url and (len(url) > 2048 or not WEBHOOK.fullmatch(url))):
        raise ValueError('RUNTIME_WEBHOOK_INVALID')
    funding = value.get('funding', {})
    if not isinstance(funding, dict) or set(funding) - {'deploysPerHour', 'policy'}: raise ValueError('RUNTIME_DECISIONS_INVALID')
    deploys = funding.get('deploysPerHour', 0)
    if type(deploys) is not int or not 0 <= deploys <= 1000: raise ValueError('RUNTIME_DEPLOYS_PER_HOUR_INVALID')
    if 'policy' in funding: validate_funding_policy(funding['policy'])


def validate_funding_policy(policy):
    """The same shape and bounds the API enforces on load (services/backend funding.ts), checked here
    so a bad policy stops at 08 instead of stopping the API at start."""
    def limit(v):
        if not isinstance(v, dict) or set(v) != FUNDING_LIMIT_KEYS: raise ValueError('RUNTIME_FUNDING_POLICY_INVALID')
        if type(v['periodSeconds']) is not int or not 1 <= v['periodSeconds'] <= 31536000: raise ValueError('RUNTIME_FUNDING_POLICY_INVALID')
        for key in ['txPerPeriod', 'perAccountPerPeriod']:
            if type(v[key]) is not int or not 0 <= v[key] <= 1000000: raise ValueError('RUNTIME_FUNDING_POLICY_INVALID')
        for key in ['maxFeePerTx', 'maxFeePerPeriod', 'perAccountMaxFeePerPeriod']:
            if not isinstance(v[key], str) or not re.fullmatch(r'[0-9]{1,78}', v[key]) or int(v[key]) > FRI_MAX:
                raise ValueError('RUNTIME_FUNDING_POLICY_INVALID')
        if int(v['maxFeePerTx']) > int(v['maxFeePerPeriod']) or int(v['perAccountMaxFeePerPeriod']) > int(v['maxFeePerPeriod']):
            raise ValueError('RUNTIME_FUNDING_POLICY_INVALID')
    if not isinstance(policy, dict) or set(policy) != {'global', 'operations', 'apps', 'allowExternalPaymaster'}:
        raise ValueError('RUNTIME_FUNDING_POLICY_INVALID')
    limit(policy['global'])
    if not isinstance(policy['operations'], dict) or set(policy['operations']) != FUNDING_OPERATIONS: raise ValueError('RUNTIME_FUNDING_POLICY_INVALID')
    for operation in policy['operations'].values(): limit(operation)
    # Approved apps (setup/16-register-sponsored-app.sh): a public key and the SHA-256 of a server
    # credential that never enters this file, as services/backend funding.ts parses them.
    if not isinstance(policy['apps'], dict) or len(policy['apps']) > 20: raise ValueError('RUNTIME_FUNDING_POLICY_INVALID')
    for key, app in policy['apps'].items():
        if not APP_KEY.fullmatch(key) or not isinstance(app, dict) or set(app) != FUNDING_LIMIT_KEYS | {'credentialHash'}:
            raise ValueError('RUNTIME_FUNDING_APP_INVALID')
        if not isinstance(app['credentialHash'], str) or not re.fullmatch(r'[0-9a-f]{64}', app['credentialHash']) or app['credentialHash'] == EMPTY_SHA256:
            raise ValueError('RUNTIME_FUNDING_APP_INVALID')
        limit({k: v for k, v in app.items() if k != 'credentialHash'})
    # External paymasters are not bounded by our signed fees; they need their own review.
    if policy['allowExternalPaymaster'] is not False: raise ValueError('RUNTIME_EXTERNAL_PAYMASTER_REQUIRES_REVIEW')


def operator_settings(decisions):
    """The reviewed example with only the operator's own decisions filled in."""
    text = (HERE.parent/'backup/operator.settings.example').read_text()
    backup = decisions.get('backup', {})
    for key, value in [('KAMUI_BACKUP_REVIEWED', 'yes' if backup.get('reviewed') else ''),
                       ('KAMUI_BACKUP_RETENTION_APPROVED', 'yes' if backup.get('retentionApproved') else ''),
                       ('KAMUI_BACKUP_MAX_AGE_SECONDS', str(backup.get('maxSuccessfulBackupAgeSeconds') or ''))]:
        if text.count('\n'+key+'=\n') != 1: raise ValueError('RUNTIME_SETTINGS_TEMPLATE_CHANGED')
        text = text.replace('\n'+key+'=\n', '\n'+key+'='+value+'\n')
    return text


def pgbackrest_conf(data, decisions):
    text = (HERE.parent/'backup/pgbackrest.conf.example').read_text().replace('REPLACE_WITH_REVIEWED_PRIVATE_BUCKET', data['backupBucket'])
    if text.count('\nrepo1-retention-full=7\n') != 1: raise ValueError('RUNTIME_SETTINGS_TEMPLATE_CHANGED')
    days = decisions.get('backup', {}).get('retentionFullDays', 7)
    return text.replace('\nrepo1-retention-full=7\n', '\nrepo1-retention-full='+str(days)+'\n')


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
    decisions = load_decisions(root)
    history = root/'installation/runtime-history'
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
    update(backend/'backend.public.env', env_bytes({'CHAIN_ID': 'SN_SEPOLIA', 'RPC_URL': RPC, 'RPC_FALLBACK_URL': RPC_FALLBACK,
        'KAMUI_ACCOUNT_CLASS_HASH': CLASS, 'AUTHORIZED_GOOGLE_RECOVERY_CLIENT_ID': data['googleClientId'],
        'RELAYER_ADDRESS': data['relayerAddress'], 'PEPPER_SERVICE_URL': PEPPER,
        # SPONSORED_PER_HOUR is unused once a funding policy file is mounted; the policy governs sponsorship.
        'DEPLOYS_PER_HOUR': str(decisions.get('funding', {}).get('deploysPerHour', 0)), 'SPONSORED_PER_HOUR': '0'}),
        history, 'backend-backend.public.env')
    update(backend/'keychain.public.env', env_bytes({'GOOGLE_CLIENT_ID': data['googleClientId'],
        'KAMUI_ACCOUNT_CLASS_HASH': CLASS, 'PROVER_EXECUTOR_ADDRESS': EXECUTOR, 'JWK_REGISTRY_ADDRESS': REGISTRY, 'PUBLIC_RPC_URL': RPC,
        'PUBLIC_RPC_FALLBACK_URL': RPC_FALLBACK}), history, 'backend-keychain.public.env')
    update(backend/'watcher.public.env', env_bytes({'CHAIN_ID': 'SN_SEPOLIA', 'RPC_URL': RPC, 'RPC_FALLBACK_URL': RPC_FALLBACK,
        'SN_SEPOLIA_REGISTRY_ADDRESS': REGISTRY, 'SN_SEPOLIA_REGISTRY_BLOCK': data['registryBlock'],
        'WATCHER_POLL_SECONDS': '60', 'WATCHER_WEBHOOK_URL': decisions.get('alerts', {}).get('watcherWebhookUrl', '')}),
        history, 'backend-watcher.public.env')
    write(pepper/'pepper.private.env', env_bytes({'KMS_KEY_ID': data['pepperKeyArn'], 'PEPPER_KEY_CHECK': data['pepperKeyCheck'],
        'GOOGLE_AUDIENCES': data['googleClientId'], 'RATE_IP_BURST': '30', 'RATE_IP_PER_MINUTE': '30',
        'RATE_SUBJECT_BURST': '10', 'RATE_SUBJECT_PER_HOUR': '10'}))
    if 'policy' in decisions.get('funding', {}):
        policy = decisions['funding']['policy']
    else:
        # No funding decision: the reviewed zero policy, which disables every paid operation.
        policy = json.loads((REPO/'services/backend/funding-policy.example.json').read_text())
        if policy.get('apps') or policy.get('allowExternalPaymaster') is not False: raise ValueError('RUNTIME_ZERO_POLICY_REQUIRED')
        for limits in [policy.get('global', {})] + list(policy.get('operations', {}).values()):
            if any(value not in (0, '0') for key,value in limits.items() if key != 'periodSeconds'): raise ValueError('RUNTIME_ZERO_POLICY_REQUIRED')
    update(backend/'funding-policy.json', json_bytes(policy), history, 'backend-funding-policy.json')
    update(backup/'pgbackrest.conf', pgbackrest_conf(data, decisions), history, 'backend-backup-pgbackrest.conf')
    # Acknowledgements stay empty unless the operator recorded them in the decisions file; nothing
    # here ever turns backup jobs on by itself.
    update(backup/'operator.settings', operator_settings(decisions), history, 'backend-backup-operator.settings')
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
    update(target/'manifest.json', json_bytes(manifest), history, 'manifest.json')
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
