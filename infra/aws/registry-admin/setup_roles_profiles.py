#!/usr/bin/env python3
"""Operator-run ordered IAM-role/profile setup. No accounts, credentials or contract changes."""
import argparse
import configparser
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from urllib.parse import unquote
import uuid
import setup_k1_key as key

NAMES = {'administrator': 'KamuiSepoliaRegistryAdmin', 'recovery': 'KamuiSepoliaRegistryRecovery', 'signing': 'KamuiSepoliaRegistrySigner'}
PROFILES = {'administrator': 'kamui-registry-admin-sepolia', 'recovery': 'kamui-registry-recovery-sepolia', 'signing': 'kamui-registry-signer-sepolia'}
ROLE_PATH = '/kamui/sepolia/registry/'
POLICY_NAME = 'KamuiSepoliaK1Bootstrap'

class RoleAws(key.Aws):
    ALLOWED = {('sts', 'get-caller-identity'), ('iam', 'get-role'), ('iam', 'create-role'),
               ('iam', 'get-role-policy'), ('iam', 'put-role-policy'),
               ('iam', 'list-role-policies'), ('iam', 'list-attached-role-policies')}

def doc(value):
    return json.loads(unquote(value)) if isinstance(value, str) else value

def bootstrap(aws, profile):
    value = aws.call(profile, 'sts', 'get-caller-identity')
    account, principal = value.get('Account'), value.get('Arn', '')
    if not isinstance(account, str) or not re.fullmatch('[0-9]{12}', account): key.fail('BOOTSTRAP_IDENTITY_INVALID')
    assumed = key.ASSUMED.fullmatch(principal)
    if assumed:
        role = aws.call(profile, 'iam', 'get-role', {'RoleName': assumed[2]}).get('Role', {})
        principal = role.get('Arn', '')
        parsed = key.ROLE.fullmatch(principal)
        if not parsed or parsed[1] != account or parsed[2].split('/')[-1] != assumed[2]: key.fail('BOOTSTRAP_IDENTITY_INVALID')
        statements = doc(role.get('AssumeRolePolicyDocument', {})).get('Statement', [])
        if not isinstance(statements, list) or not statements or any(isinstance(s.get('Principal'), dict) and 'Service' in s['Principal'] for s in statements):
            key.fail('BOOTSTRAP_SERVICE_ROLE_NOT_ALLOWED')
    elif not re.fullmatch(r'arn:aws:iam::' + account + r':user/[A-Za-z0-9_+=,.@/-]+', principal):
        key.fail('BOOTSTRAP_MUST_BE_OPERATOR_USER_OR_ROLE_NOT_ROOT')
    return {'account': account, 'principal': principal}

def definitions(account):
    return {label: {'name': name, 'arn': 'arn:aws:iam::' + account + ':role' + ROLE_PATH + name, 'profile': PROFILES[label]} for label, name in NAMES.items()}

def trust_policy(principal):
    return {'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow', 'Principal': {'AWS': principal}, 'Action': 'sts:AssumeRole'}]}

def administrator_policy(roles):
    # Named API requirements; KMS key operations after creation are granted by its exact resource policy.
    return {'Version': '2012-10-17', 'Statement': [
        {'Sid': 'CreateOnlyIrelandSingleRegionK1Keys', 'Effect': 'Allow', 'Action': 'kms:CreateKey', 'Resource': '*',
         'Condition': {'StringEquals': {'aws:RequestedRegion': key.REGION, 'kms:KeySpec': 'ECC_SECG_P256K1',
             'kms:KeyUsage': 'SIGN_VERIFY', 'kms:KeyOrigin': 'AWS_KMS'},
             'Bool': {'kms:MultiRegion': 'false', 'kms:BypassPolicyLockoutSafetyCheck': 'false'}}},
        {'Sid': 'InspectOnlyTheseOperatorRoles', 'Effect': 'Allow', 'Action': 'iam:GetRole',
         'Resource': [roles[label]['arn'] for label in key.LABELS]}]}

def current_config_path():
    path = Path(os.environ.get('AWS_CONFIG_FILE', str(Path.home() / '.aws' / 'config'))).expanduser().absolute()
    if path.is_symlink() or path.resolve().is_relative_to(key.REPO): key.fail('AWS_CONFIG_PATH_UNSAFE')
    return path

def make_plan(root, aws, profile, config_path):
    if any((root / name).exists() for name in ['setup-config.json', 'creation-attempt.json', 'admin-key.json', 'key-policy.json']):
        key.fail('EXISTING_KEY_SETUP_REQUIRES_RECONCILIATION_BEFORE_ROLE_BOOTSTRAP')
    if profile in PROFILES.values(): key.fail('BOOTSTRAP_PROFILE_CANNOT_BE_A_TARGET')
    if any(name in aws.profiles() for name in PROFILES.values()): key.fail('EXISTING_PROFILE_COLLISION')
    existing = parse_config(config_bytes(config_path))
    if existing.defaults(): key.fail('AWS_CONFIG_DEFAULTS_UNSUPPORTED')
    if any(existing.has_section('profile ' + name) for name in PROFILES.values()): key.fail('EXISTING_PROFILE_COLLISION')
    identity = bootstrap(aws, profile)
    roles = definitions(identity['account'])
    # No existing role is overwritten/adopted during initial planning.
    for role in roles.values():
        try: aws.call(profile, 'iam', 'get-role', {'RoleName': role['name']})
        except key.AwsServiceError as error:
            if error.code == 'NoSuchEntity': continue
            raise
        key.fail('TARGET_ROLE_ALREADY_EXISTS_NOT_OWNED_BY_THIS_SETUP')
    plan = {'version': 1, 'runId': uuid.uuid4().hex, 'bootstrapProfile': profile,
        'bootstrap': identity, 'roles': roles, 'trust': trust_policy(identity['principal']),
        'administratorPolicy': administrator_policy(roles), 'configPath': str(config_path)}
    key.write_private(root, 'roles-plan.json', plan)
    return plan

def load_plan(root):
    plan = key.read_private(root, 'roles-plan.json')
    if set(plan) != {'version', 'runId', 'bootstrapProfile', 'bootstrap', 'roles', 'trust', 'administratorPolicy', 'configPath'} or plan['version'] != 1:
        key.fail('ROLE_PLAN_INVALID')
    if not re.fullmatch('[a-f0-9]{32}', plan['runId']) or not re.fullmatch('[0-9]{12}', plan['bootstrap']['account']): key.fail('ROLE_PLAN_INVALID')
    if plan['roles'] != definitions(plan['bootstrap']['account']) or plan['bootstrapProfile'] in PROFILES.values(): key.fail('ROLE_PLAN_INVALID')
    principal = plan['bootstrap']['principal']
    if not re.fullmatch(r'arn:aws:iam::' + plan['bootstrap']['account'] + r':(?:role|user)/[A-Za-z0-9_+=,.@/-]+', principal): key.fail('ROLE_PLAN_INVALID')
    if plan['trust'] != trust_policy(principal) or plan['administratorPolicy'] != administrator_policy(plan['roles']): key.fail('ROLE_PLAN_INVALID')
    if current_config_path() != Path(plan['configPath']): key.fail('AWS_CONFIG_PATH_CHANGED')
    if (root / 'roles-approved.json').exists() and key.read_private(root, 'roles-approved.json') != {'planSha256': key.digest(plan)}:
        key.fail('APPROVED_ROLE_PLAN_CHANGED')
    return plan

def check_bootstrap(aws, plan):
    if bootstrap(aws, plan['bootstrapProfile']) != plan['bootstrap']: key.fail('BOOTSTRAP_IDENTITY_CHANGED')

def tags(plan, label):
    return [{'Key': 'kamui-setup', 'Value': plan['runId']}, {'Key': 'kamui-purpose', 'Value': 'sepolia-registry-' + label}]

def verify_role(plan, label, role):
    expected = plan['roles'][label]
    if (role.get('Arn') != expected['arn'] or role.get('RoleName') != expected['name'] or role.get('Path') != ROLE_PATH
        or role.get('MaxSessionDuration') != 3600 or role.get('PermissionsBoundary')
        or doc(role.get('AssumeRolePolicyDocument')) != plan['trust']
        or {t['Key']: t['Value'] for t in role.get('Tags', [])} != {t['Key']: t['Value'] for t in tags(plan, label)}):
        key.fail('CREATED_ROLE_DRIFT_OR_FOREIGN_ROLE')

def role_permissions(aws, plan, label):
    args = {'RoleName': plan['roles'][label]['name']}
    inline = aws.call(plan['bootstrapProfile'], 'iam', 'list-role-policies', args)
    attached = aws.call(plan['bootstrapProfile'], 'iam', 'list-attached-role-policies', args)
    if inline.get('IsTruncated') or attached.get('IsTruncated') or attached.get('AttachedPolicies') != []: key.fail('UNEXPECTED_ROLE_PERMISSIONS')
    names = inline.get('PolicyNames')
    if not isinstance(names, list) or (label != 'administrator' and names) or any(name != POLICY_NAME for name in names): key.fail('UNEXPECTED_ROLE_PERMISSIONS')
    if names:
        saved = aws.call(plan['bootstrapProfile'], 'iam', 'get-role-policy', {**args, 'PolicyName': POLICY_NAME})
        if doc(saved.get('PolicyDocument')) != plan['administratorPolicy']: key.fail('ADMINISTRATOR_POLICY_DRIFT')
    return bool(names)

def provision_roles(root, aws, plan, confirm):
    if not (root / 'roles-approved.json').exists():
        if confirm(key.digest(plan)) is not True: key.fail('ROLE_CREATION_CANCELLED')
        check_bootstrap(aws, plan)
        key.write_private(root, 'roles-approved.json', {'planSha256': key.digest(plan)})
    elif key.read_private(root, 'roles-approved.json') != {'planSha256': key.digest(plan)}: key.fail('APPROVED_ROLE_PLAN_CHANGED')
    check_bootstrap(aws, plan)
    for label in key.LABELS:
        role = plan['roles'][label]; marker = 'role-attempt-' + label + '.json'
        try:
            actual = aws.call(plan['bootstrapProfile'], 'iam', 'get-role', {'RoleName': role['name']})['Role']
            if not (root / marker).exists(): key.fail('TARGET_ROLE_ALREADY_EXISTS_NOT_OWNED_BY_THIS_SETUP')
        except key.AwsServiceError as error:
            if error.code != 'NoSuchEntity': raise
            if (root / marker).exists(): key.fail('ROLE_CREATION_UNCERTAIN_RECONCILE_BEFORE_CONTINUING')
            request = {'RoleName': role['name'], 'Path': ROLE_PATH, 'MaxSessionDuration': 3600,
                'Description': 'Kamui Sepolia off-server registry ' + label,
                'AssumeRolePolicyDocument': json.dumps(plan['trust'], sort_keys=True), 'Tags': tags(plan, label)}
            key.write_private(root, marker, {'request': request, 'planSha256': key.digest(plan)})
            created = aws.call(plan['bootstrapProfile'], 'iam', 'create-role', request).get('Role', {})
            if created.get('Arn') != role['arn'] or created.get('RoleName') != role['name']:
                key.fail('CREATED_ROLE_REPLY_MISMATCH_RECONCILE')
            # CreateRole omits MaxSessionDuration in live replies. Verify full GetRole state.
            actual = aws.call(plan['bootstrapProfile'], 'iam', 'get-role', {'RoleName': role['name']})['Role']
        verify_role(plan, label, actual)
        has_policy = role_permissions(aws, plan, label)
        if label == 'administrator' and not has_policy:
            marker = 'administrator-policy-attempt.json'
            if (root / marker).exists(): key.fail('POLICY_WRITE_UNCERTAIN_RECONCILE_BEFORE_CONTINUING')
            request = {'RoleName': role['name'], 'PolicyName': POLICY_NAME, 'PolicyDocument': json.dumps(plan['administratorPolicy'], sort_keys=True)}
            key.write_private(root, marker, {'request': request, 'planSha256': key.digest(plan)})
            aws.call(plan['bootstrapProfile'], 'iam', 'put-role-policy', request)
    verify_roles(root, aws, plan)
    if not (root / 'roles-complete.json').exists(): key.write_private(root, 'roles-complete.json', {'planSha256': key.digest(plan)})

def verify_roles(root, aws, plan):
    if key.read_private(root, 'roles-approved.json') != {'planSha256': key.digest(plan)}: key.fail('ROLE_APPROVAL_REQUIRED')
    check_bootstrap(aws, plan)
    for label, role in plan['roles'].items():
        if not (root / ('role-attempt-' + label + '.json')).exists(): key.fail('ROLE_SETUP_INCOMPLETE')
        actual = aws.call(plan['bootstrapProfile'], 'iam', 'get-role', {'RoleName': role['name']})['Role']
        verify_role(plan, label, actual)
        if role_permissions(aws, plan, label) != (label == 'administrator'): key.fail('ROLE_SETUP_INCOMPLETE')

def parse_config(raw):
    parser = configparser.RawConfigParser(strict=True)
    parser.read_string(raw.decode('utf-8'))
    return parser

def profile_text(plan):
    return ''.join('\n[profile ' + role['profile'] + ']\nrole_arn = ' + role['arn']
        + '\nsource_profile = ' + plan['bootstrapProfile'] + '\nregion = ' + key.REGION
        + '\nduration_seconds = 3600\n' for role in plan['roles'].values()).encode()

def config_bytes(path):
    if not path.exists():
        if path.is_symlink(): key.fail('AWS_CONFIG_SYMLINK_REFUSED')
        return b''
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_size > 1024 * 1024: key.fail('AWS_CONFIG_FILE_UNSAFE')
        raw = file.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024: key.fail('AWS_CONFIG_FILE_UNSAFE')
        return raw

def sha(raw): return hashlib.sha256(raw).hexdigest()

def verify_profiles(root, plan):
    receipt = key.read_private(root, 'profiles-complete.json')
    if receipt.get('planSha256') != key.digest(plan): key.fail('PROFILE_PLAN_MISMATCH')
    raw = config_bytes(Path(plan['configPath']))
    # Existing unrelated profile edits are allowed; the three dedicated sections stay exact.
    config = parse_config(raw)
    for role in plan['roles'].values():
        section = 'profile ' + role['profile']
        expected = {'role_arn': role['arn'], 'source_profile': plan['bootstrapProfile'], 'region': key.REGION, 'duration_seconds': '3600'}
        if not config.has_section(section) or dict(config.items(section)) != expected: key.fail('DEDICATED_PROFILE_DRIFT')

def install_profiles(root, plan, confirm):
    path = Path(plan['configPath'])
    if (root / 'profiles-complete.json').exists(): verify_profiles(root, plan); return
    if not path.parent.exists(): path.parent.mkdir(mode=0o700)
    if path.parent.is_symlink() or path.parent.stat().st_uid != os.getuid() or path.parent.stat().st_mode & 0o022: key.fail('AWS_CONFIG_PARENT_UNSAFE')
    lock = os.open(str(path) + '.kamui-lock', os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        os.fsync(lock); key.sync_directory(path.parent)
        old = config_bytes(path); config = parse_config(old)
        if (root / 'profiles-write-attempt.json').exists():
            intent = key.read_private(root, 'profiles-write-attempt.json')
            if intent != {'planSha256': key.digest(plan), 'beforeSha256': sha(key.read_private(root, 'aws-config-backup.json')['bytes'].encode()), 'afterSha256': sha(old)}:
                key.fail('PROFILE_WRITE_UNCERTAIN_RECONCILE_BEFORE_CONTINUING')
        else:
            if any(config.has_section('profile ' + name) for name in PROFILES.values()): key.fail('EXISTING_PROFILE_COLLISION')
            # Preserve original bytes/comments rather than rewriting with configparser.
            new = old + (b'' if not old or old.endswith(b'\n') else b'\n') + profile_text(plan)
            if confirm(sha(new)) is not True: key.fail('PROFILE_WRITE_CANCELLED')
            if config_bytes(path) != old: key.fail('AWS_CONFIG_CHANGED_DURING_REVIEW')
            key.write_private(root, 'aws-config-backup.json', {'bytes': old.decode('utf-8')})
            key.write_private(root, 'profiles-write-attempt.json', {'planSha256': key.digest(plan), 'beforeSha256': sha(old), 'afterSha256': sha(new)})
            temp = path.parent / ('.kamui-config-' + uuid.uuid4().hex)
            fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as file: file.write(new); file.flush(); os.fsync(file.fileno())
            if config_bytes(path) != old: key.fail('AWS_CONFIG_CHANGED_DURING_WRITE')
            os.replace(temp, path); key.sync_directory(path.parent)
        key.write_private(root, 'profiles-complete.json', {'planSha256': key.digest(plan)})
        verify_profiles(root, plan)
    finally:
        os.close(lock); os.unlink(str(path) + '.kamui-lock'); key.sync_directory(path.parent)

def select_bootstrap(aws):
    profiles = aws.profiles()
    print('Select ONE existing operator administrator profile for the approved test account.')
    for i, name in enumerate(profiles, 1): print(str(i) + '. ' + re.sub(r'arn:[^ ]+|[0-9]{12}', '<redacted>', name))
    value = input('Bootstrap profile number: ')
    if not value.isdecimal() or not 1 <= int(value) <= len(profiles): key.fail('PROFILE_NUMBER_REQUIRED')
    return profiles[int(value) - 1]

def main(argv=None, execute=subprocess.run):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('step', choices=['roles', 'profiles', 'key'])
    parser.add_argument('--directory', type=Path, default=Path.home() / '.kamui-admin-sepolia')
    args = parser.parse_args(argv)
    try:
        os.umask(0o077)
        if not sys.stdin.isatty(): key.fail('INTERACTIVE_OPERATOR_TERMINAL_REQUIRED')
        root = key.private_directory(args.directory); aws = RoleAws(root, execute)
        if args.step == 'roles':
            plan = load_plan(root) if (root / 'roles-plan.json').exists() else make_plan(root, aws, select_bootstrap(aws), current_config_path())
            def confirm(fingerprint):
                print('Review roles-plan.json privately. Creates three operator roles; no accounts or key yet.')
                print('All three trust the selected bootstrap identity: this is NOT independent recovery.')
                print('Admin: constrained k1 key creation and inspection of these three roles. Other roles use the later key policy only.')
                return input('Type CREATE ROLES ' + fingerprint[:12] + ': ') == 'CREATE ROLES ' + fingerprint[:12]
            if (root / 'roles-complete.json').exists():
                if key.read_private(root, 'roles-complete.json') != {'planSha256': key.digest(plan)}: key.fail('COMPLETED_ROLE_PLAN_CHANGED')
                verify_roles(root, aws, plan)
            else:
                provision_roles(root, aws, plan, confirm)
            print('THREE_ROLES_CREATED_AND_VERIFIED')
        else:
            plan = load_plan(root); verify_roles(root, aws, plan)
            if args.step == 'profiles':
                def confirm(fingerprint):
                    print('Append three dedicated role profiles to your existing AWS config; preserve a private backup. No credentials are created.')
                    return input('Type ADD PROFILES ' + fingerprint[:12] + ': ') == 'ADD PROFILES ' + fingerprint[:12]
                install_profiles(root, plan, confirm)
                for label, role in plan['roles'].items():
                    observed = key.identity(key.Aws(root, execute), role['profile'], plan['bootstrapProfile'])
                    if observed != {'account': plan['bootstrap']['account'], 'role': role['arn']}: key.fail('CREATED_PROFILE_IDENTITY_MISMATCH')
                print('THREE_PROFILES_CONFIGURED_AND_ASSUMPTION_VERIFIED')
            else:
                verify_profiles(root, plan)
                profiles = {label: role['profile'] for label, role in plan['roles'].items()}
                if not (root / 'setup-config.json').exists(): key.prepare(root, key.Aws(root, execute), profiles)
                config, _ = key.load(root)
                if config['profiles'] != profiles or config['roles'] != {label: role['arn'] for label, role in plan['roles'].items()}:
                    key.fail('KEY_SETUP_USES_DIFFERENT_ROLES')
                return key.main(['setup', '--directory', str(root)], execute)
        return 0
    except key.Refused as error: print(str(error), file=sys.stderr); return 1
    except (Exception, KeyboardInterrupt): print('ROLE_PROFILE_SETUP_FAILED_PRIVATE_FILES_RETAINED', file=sys.stderr); return 1

if __name__ == '__main__': sys.exit(main())
