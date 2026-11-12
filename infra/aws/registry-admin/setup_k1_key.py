#!/usr/bin/env python3
"""Operator-only KMS k1 setup. No private-key input, role creation or contract transactions."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import uuid

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
REGION = 'eu-west-1'
LABELS = ('administrator', 'recovery', 'signing')
ROLE = re.compile(r'arn:aws:iam::([0-9]{12}):role/([A-Za-z0-9_+=,.@/-]+)')
ASSUMED = re.compile(r'arn:aws:sts::([0-9]{12}):assumed-role/([A-Za-z0-9_+=,.@-]+)/[^/]+')
KEY = re.compile(r'arn:aws:kms:eu-west-1:([0-9]{12}):key/[a-f0-9-]{36}')

class Refused(Exception):
    pass

class AwsServiceError(Refused):
    def __init__(self, code):
        self.code = code
        super().__init__('AWS_RESOURCE_NOT_FOUND_PRIVATE_LOGS_RETAINED')

def fail(code):
    raise Refused(code)

def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()

def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()

def private_directory(path):
    path = Path(path).expanduser().absolute()
    if path.is_symlink() or path.resolve().is_relative_to(REPO):
        fail('PRIVATE_DIRECTORY_OUTSIDE_REPOSITORY_REQUIRED')
    if not path.exists():
        path.mkdir(mode=0o700)
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        fail('PRIVATE_DIRECTORY_OWNER_MODE_REQUIRED')
    return path

def sync_directory(root):
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def write_private(root, name, value):
    fd = os.open(root / name, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as file:
        file.write(value if isinstance(value, bytes) else encoded(value))
        file.flush()
        os.fsync(file.fileno())
    sync_directory(root)

def read_private(root, name):
    fd = os.open(root / name, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size > 128 * 1024:
            fail('PRIVATE_FILE_OWNER_MODE_REQUIRED')
        return json.loads(file.read(128 * 1024 + 1))

class Aws:
    """AWS CLI inputs use exclusive private files; raw output/errors never reach the terminal."""
    ALLOWED = {('sts', 'get-caller-identity'), ('iam', 'get-role'),
               ('kms', 'create-key'), ('kms', 'get-public-key')}
    def __init__(self, root, execute=subprocess.run):
        self.root, self.execute = root, execute

    READS = {('configure', 'list-profiles'), ('sts', 'get-caller-identity'),
             ('iam', 'get-role'), ('iam', 'get-role-policy'), ('iam', 'list-role-policies'),
             ('iam', 'list-attached-role-policies'), ('kms', 'get-public-key'),
             ('kms', 'describe-key'), ('kms', 'get-key-policy')}

    def invoke(self, command, request=None):
        environment = dict(os.environ, AWS_MAX_ATTEMPTS='1', AWS_PAGER='', AWS_CLI_AUTO_PROMPT='off')
        # Explicit profiles must not be silently replaced by stale environment credentials.
        for name in ('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN',
                     'AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_SESSION_NAME',
                     'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI',
                     'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_KMS', 'AWS_ENDPOINT_URL_STS', 'AWS_ENDPOINT_URL_IAM'):
            environment.pop(name, None)
        environment['AWS_EC2_METADATA_DISABLED'] = 'true'
        environment['AWS_IGNORE_CONFIGURED_ENDPOINT_URLS'] = 'true'
        operation = tuple(command[1:3])
        read_only = operation in self.READS
        action = ':'.join(operation) if all(re.fullmatch('[a-z-]+', part) for part in operation) else 'aws:operation'
        limit = 3 if read_only else 1
        for attempt in range(1, limit + 1):
            token = uuid.uuid4().hex
            write_private(self.root, 'aws-' + token + '.call.json', {
                'service': operation[0], 'operation': operation[1], 'readOnly': read_only,
                'attempt': attempt, 'maximumAttempts': limit,
            })
            timed_out = False
            try:
                result = self.execute(command, input=encoded(request) if request is not None else None,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment, timeout=45)
                output, error = result.stdout, result.stderr
            except subprocess.TimeoutExpired as exc:
                output, error = exc.stdout or b'', exc.stderr or b''
                timed_out = True
            write_private(self.root, 'aws-' + token + '.stdout', output)
            write_private(self.root, 'aws-' + token + '.stderr', error)
            network_failure = any(text in error.lower() for text in (
                b'read timeout on endpoint url', b'connect timeout on endpoint url',
                b'could not connect to the endpoint url'))
            if timed_out or (result.returncode != 0 and network_failure):
                if read_only and attempt < limit:
                    print('AWS_READ_RETRY ' + action + ' attempt ' + str(attempt + 1) + '/' + str(limit), file=sys.stderr)
                    continue
                label = 'AWS_READ_TIMEOUT' if read_only else 'AWS_MUTATION_UNCERTAIN'
                fail(label + ' ' + action + ' PRIVATE_LOGS_RETAINED')
            if result.returncode:
                if operation in (('iam', 'get-role'), ('iam', 'get-role-policy')) and re.search(
                    rb'An error occurred \(NoSuchEntity\) when calling the '
                    + {'get-role': b'GetRole', 'get-role-policy': b'GetRolePolicy'}[operation[1]] + rb' operation\b', error):
                    raise AwsServiceError('NoSuchEntity')
                label = 'AWS_READ_FAILED' if read_only else 'AWS_MUTATION_FAILED_OR_UNCERTAIN'
                fail(label + ' ' + action + ' PRIVATE_LOGS_RETAINED')
            if len(output) > 128 * 1024:
                fail('AWS_REPLY_INVALID')
            return output

    def profiles(self):
        raw = self.invoke(['aws', 'configure', 'list-profiles', '--no-cli-pager'])
        values = raw.decode().splitlines()
        if not values or any(not value or len(value) > 128 or any(ord(c) < 32 for c in value) for value in values):
            fail('EXISTING_AWS_PROFILES_REQUIRED')
        return values

    def call(self, profile, service, operation, request=None):
        if (service, operation) not in self.ALLOWED:
            fail('AWS_OPERATION_FORBIDDEN')
        command = ['aws', service, operation, '--profile', profile, '--region', REGION,
                   '--output', 'json', '--no-cli-pager', '--no-cli-auto-prompt',
                   '--cli-connect-timeout', '5', '--cli-read-timeout', '15']
        if request is not None:
            name = 'aws-request-' + uuid.uuid4().hex + '.json'
            write_private(self.root, name, request)
            command.extend(['--cli-input-json', 'file://' + str(self.root / name)])
        output = self.invoke(command)
        # IAM PutRolePolicy has a successful empty CLI response (HTTP 200, no body).
        if (service, operation) == ('iam', 'put-role-policy') and not output.strip():
            return {}
        return json.loads(output)

def identity(aws, profile, reader_profile=None):
    value = aws.call(profile, 'sts', 'get-caller-identity')
    match = ASSUMED.fullmatch(value.get('Arn', ''))
    if not match or value.get('Account') != match[1]:
        fail('EXISTING_ASSUMED_ROLE_PROFILE_REQUIRED')
    role = aws.call(reader_profile or profile, 'iam', 'get-role', {'RoleName': match[2]}).get('Role', {})
    arn = role.get('Arn', '')
    parsed = ROLE.fullmatch(arn)
    if not parsed or parsed[1] != match[1] or parsed[2].split('/')[-1] != match[2] or role.get('RoleName') != match[2]:
        fail('AWS_ROLE_IDENTITY_MISMATCH')
    trust = role.get('AssumeRolePolicyDocument')
    if isinstance(trust, str):
        from urllib.parse import unquote
        trust = json.loads(unquote(trust))
    statements = trust.get('Statement', []) if isinstance(trust, dict) else None
    if not isinstance(statements, list) or not statements:
        fail('ROLE_TRUST_REVIEW_REQUIRED')
    if any(isinstance(s, dict) and isinstance(s.get('Principal'), dict) and 'Service' in s['Principal'] for s in statements):
        fail('AWS_SERVICE_ROLE_NOT_ALLOWED')
    return {'account': parsed[1], 'role': arn}

def policy_for(roles):
    policy = json.loads((HERE / 'key-policy.review-template.json').read_text())
    policy['Statement'][0]['Principal']['AWS'] = [roles['administrator'], roles['recovery']]
    policy['Statement'][1]['Principal']['AWS'] = roles['signing']
    policy['Statement'][2]['Principal']['AWS'] = roles['signing']
    return policy

def prepare(root, aws, profiles):
    if (root / 'setup-config.json').exists() or (root / 'creation-attempt.json').exists():
        fail('SETUP_ALREADY_PREPARED_USE_EXISTING_DIRECTORY')
    observed = {label: identity(aws, profiles[label], profiles['administrator']) for label in LABELS}
    if len({v['account'] for v in observed.values()}) != 1:
        fail('ROLES_MUST_USE_SAME_APPROVED_ACCOUNT')
    roles = {label: value['role'] for label, value in observed.items()}
    if len(set(roles.values())) != 3:
        fail('THREE_DISTINCT_EXISTING_ROLES_REQUIRED')
    policy = policy_for(roles)
    config = {'version': 1, 'region': REGION, 'account': observed['administrator']['account'],
              'profiles': profiles, 'roles': roles, 'policySha256': digest(policy)}
    # Exclusive writes: preparation never replaces an earlier operator policy/config.
    write_private(root, 'key-policy.json', policy)
    write_private(root, 'setup-config.json', config)
    return config

def load(root):
    config = read_private(root, 'setup-config.json')
    if set(config) != {'version', 'region', 'account', 'profiles', 'roles', 'policySha256'} or config['version'] != 1 or config['region'] != REGION:
        fail('SETUP_CONFIG_INVALID')
    if set(config['profiles']) != set(LABELS) or set(config['roles']) != set(LABELS) or len(set(config['roles'].values())) != 3:
        fail('SETUP_CONFIG_INVALID')
    for label in LABELS:
        profile = config['profiles'][label]
        role = ROLE.fullmatch(config['roles'][label])
        if not isinstance(profile, str) or not profile or len(profile) > 128 or not role or role[1] != config['account']:
            fail('SETUP_CONFIG_INVALID')
    policy = read_private(root, 'key-policy.json')
    if policy != policy_for(config['roles']) or digest(policy) != config['policySha256']:
        fail('PREPARED_POLICY_CHANGED_REFUSING_CREATION')
    return config, policy

def key_metadata(value, config):
    metadata = value.get('KeyMetadata', {})
    match = KEY.fullmatch(metadata.get('Arn', ''))
    if (not match or match[1] != config['account'] or metadata.get('AWSAccountId') != config['account']
        or metadata.get('KeySpec') != 'ECC_SECG_P256K1' or metadata.get('KeyUsage') != 'SIGN_VERIFY'
        or metadata.get('Origin') != 'AWS_KMS' or metadata.get('KeyState') != 'Enabled'
        or metadata.get('KeyManager') != 'CUSTOMER' or metadata.get('MultiRegion') is not False):
        fail('CREATED_KEY_METADATA_MISMATCH')
    return metadata

def create(root, aws, confirm):
    # Check before reads/prompts: an ambiguous creation is never retried automatically.
    if (root / 'creation-attempt.json').exists() or (root / 'admin-key.json').exists():
        fail('KEY_CREATION_ALREADY_ATTEMPTED_DO_NOT_RETRY')
    config, policy = load(root)
    for label in LABELS:
        observed = identity(aws, config['profiles'][label], config['profiles']['administrator'])
        if observed != {'account': config['account'], 'role': config['roles'][label]}:
            fail('AWS_PROFILE_IDENTITY_CHANGED')
    if confirm(config['policySha256']) is not True:
        fail('KEY_CREATION_CANCELLED')
    # Confirmation may stay open while profiles change; recheck the creator after it.
    if identity(aws, config['profiles']['administrator']) != {'account': config['account'], 'role': config['roles']['administrator']}:
        fail('AWS_PROFILE_IDENTITY_CHANGED')
    attempt = uuid.uuid4().hex
    request = {'KeySpec': 'ECC_SECG_P256K1', 'KeyUsage': 'SIGN_VERIFY', 'Origin': 'AWS_KMS',
               'MultiRegion': False, 'BypassPolicyLockoutSafetyCheck': False,
               'Description': 'Kamui Sepolia manual registry administrator ' + attempt,
               'Policy': json.dumps(policy, sort_keys=True)}
    # Intent persists before the one mutating AWS call. No reset/force/retry option exists.
    write_private(root, 'creation-attempt.json', {'attempt': attempt, 'policySha256': config['policySha256'], 'request': request})
    result = aws.call(config['profiles']['administrator'], 'kms', 'create-key', request)
    key_metadata(result, config)
    write_private(root, 'admin-key.json', result)

def export_public(root, aws):
    config, _ = load(root)
    metadata = key_metadata(read_private(root, 'admin-key.json'), config)
    if identity(aws, config['profiles']['signing'], config['profiles']['administrator']) != {'account': config['account'], 'role': config['roles']['signing']}:
        fail('AWS_PROFILE_IDENTITY_CHANGED')
    value = aws.call(config['profiles']['signing'], 'kms', 'get-public-key', {'KeyId': metadata['Arn']})
    validate_public(value, metadata)
    write_private(root, 'admin-public-key.json', value)

def validate_public(value, metadata):
    if (value.get('KeyId') != metadata['Arn'] or value.get('KeySpec') != 'ECC_SECG_P256K1'
        or value.get('KeyUsage') != 'SIGN_VERIFY' or 'ECDSA_SHA_256' not in value.get('SigningAlgorithms', [])):
        fail('PUBLIC_KEY_METADATA_MISMATCH')
    point = base64.b64decode(value['PublicKey'], validate=True)
    prefix = bytes.fromhex('3056301006072a8648ce3d020106052b8104000a034200')
    if len(point) != len(prefix) + 65 or not point.startswith(prefix + b'\x04'):
        fail('PUBLIC_KEY_ENCODING_INVALID')
    x, y = int.from_bytes(point[-64:-32], 'big'), int.from_bytes(point[-32:], 'big')
    p = 2**256 - 2**32 - 977
    if x >= p or y >= p or (y*y - x*x*x - 7) % p:
        fail('PUBLIC_KEY_ENCODING_INVALID')

def select_profiles(aws, ask=input, tell=print):
    profiles = aws.profiles()
    tell('Select existing role profiles in the same approved account. No roles are created.')
    for number, name in enumerate(profiles, 1):
        safe = re.sub(r'arn:[^ ]+|[0-9]{12}', '<redacted>', name)
        tell(str(number) + '. ' + safe)
    selected = {}
    for label in LABELS:
        answer = ask('Profile number for ' + label + ': ')
        if not answer.isdecimal() or not 1 <= int(answer) <= len(profiles):
            fail('PROFILE_NUMBER_REQUIRED')
        selected[label] = profiles[int(answer) - 1]
    return selected

def status(root):
    if (root / 'admin-public-key.json').exists(): return 'KEY_PUBLIC_METADATA_SAVED'
    if (root / 'admin-key.json').exists(): return 'KEY_CREATED_PUBLIC_EXPORT_PENDING'
    if (root / 'creation-attempt.json').exists(): return 'KEY_CREATION_UNCERTAIN_DO_NOT_RETRY'
    if (root / 'setup-config.json').exists(): return 'POLICY_PREPARED_NO_KEY_CREATED'
    return 'SETUP_NOT_PREPARED'

def main(argv=None, execute=subprocess.run):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', nargs='?', choices=['setup', 'prepare', 'create', 'export-public', 'status'], default='setup')
    parser.add_argument('--directory', type=Path, default=Path.home() / '.kamui-admin-sepolia')
    args = parser.parse_args(argv)
    try:
        os.umask(0o077)
        root = private_directory(args.directory)
        if args.action == 'status':
            print(status(root)); return 0
        if not sys.stdin.isatty(): fail('INTERACTIVE_OPERATOR_TERMINAL_REQUIRED')
        aws = Aws(root, execute)
        if args.action in {'setup', 'prepare'} and not (root / 'setup-config.json').exists():
            prepare(root, aws, select_profiles(aws))
        if args.action in {'setup', 'create'}:
            if args.action == 'create' or not (root / 'admin-key.json').exists():
                def confirm(fingerprint):
                    print('Review the private key-policy.json in your selected directory.')
                    print('Policy SHA256: ' + fingerprint)
                    print('Administrator and recovery roles: key-policy read/change and key description access.')
                    print('Signing role: public-key access and ECDSA_SHA_256 / DIGEST signing.')
                    print('Policy administrators can change this policy to grant signing access.')
                    print('Creates one billed, single-Region KMS k1 signing key; no IAM/contract changes.')
                    return input('Type CREATE ' + fingerprint[:12] + ' after reviewing the policy: ') == 'CREATE ' + fingerprint[:12]
                create(root, aws, confirm)
        if args.action in {'setup', 'export-public'}:
            if not (root / 'admin-public-key.json').exists(): export_public(root, aws)
            else:
                config, _ = load(root)
                validate_public(read_private(root, 'admin-public-key.json'),
                                key_metadata(read_private(root, 'admin-key.json'), config))
        print(status(root))
        return 0
    except Refused as error:
        print(str(error), file=sys.stderr); return 1
    except (Exception, KeyboardInterrupt):
        print('K1_SETUP_FAILED_PRIVATE_FILES_RETAINED', file=sys.stderr); return 1

if __name__ == '__main__':
    sys.exit(main())
