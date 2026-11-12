"""Local IAM/profile workflow regressions. All AWS operations use an in-memory fake."""
import configparser
from contextlib import redirect_stdout, redirect_stderr
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import setup_roles_profiles as m
import setup_k1_key as key
from test_setup_k1_key import SPKI, metadata
import base64
ACCOUNT = '0' * 12
PRINCIPAL = ':'.join(['arn', 'aws', 'iam', '', ACCOUNT, 'user/test-operator'])

class FakeAws:
    def __init__(self):
        self.roles = {}; self.policies = {}; self.calls = []; self.failure = None; self.hidden = set()
        self.principal = PRINCIPAL; self.account = ACCOUNT; self.inventory = ['bootstrap']
    def profiles(self): return self.inventory
    def call(self, profile, service, operation, request=None):
        self.calls.append((profile, service, operation, copy.deepcopy(request)))
        if operation == 'get-caller-identity':
            if profile == 'bootstrap': return {'Account': self.account, 'Arn': self.principal}
            label = next(label for label, name in m.PROFILES.items() if name == profile)
            return {'Account': ACCOUNT, 'Arn': ':'.join(['arn', 'aws', 'sts', '', ACCOUNT, 'assumed-role/' + m.NAMES[label] + '/test'])}
        if operation == 'get-role':
            name = request['RoleName']
            if name in self.hidden or name not in self.roles: raise key.AwsServiceError('NoSuchEntity')
            return {'Role': copy.deepcopy(self.roles[name])}
        if operation == 'create-role':
            role = {k: copy.deepcopy(v) for k, v in request.items() if k != 'AssumeRolePolicyDocument'}
            role['Arn'] = m.definitions(ACCOUNT)[next(label for label, name in m.NAMES.items() if name == role['RoleName'])]['arn']
            role['AssumeRolePolicyDocument'] = json.loads(request['AssumeRolePolicyDocument'])
            if role['RoleName'] in self.roles: raise AssertionError('duplicate role mutation')
            self.roles[role['RoleName']] = role
            if self.failure == 'create-role': raise key.Refused('AWS_REQUEST_UNCERTAIN_PRIVATE_LOGS_RETAINED')
            reply = copy.deepcopy(role); reply.pop('MaxSessionDuration')
            return {'Role': reply}
        if operation == 'list-role-policies':
            return {'PolicyNames': [m.POLICY_NAME] if request['RoleName'] in self.policies else [], 'IsTruncated': False}
        if operation == 'list-attached-role-policies': return {'AttachedPolicies': [], 'IsTruncated': False}
        if operation == 'get-role-policy': return {'PolicyDocument': copy.deepcopy(self.policies[request['RoleName']])}
        if operation == 'put-role-policy':
            self.policies[request['RoleName']] = json.loads(request['PolicyDocument'])
            if self.failure == 'put-role-policy': raise key.Refused('AWS_REQUEST_UNCERTAIN_PRIVATE_LOGS_RETAINED')
            return {}
        if operation == 'create-key': return metadata()
        if operation == 'get-public-key':
            return {'KeyId': metadata()['KeyMetadata']['Arn'], 'KeySpec': 'ECC_SECG_P256K1', 'KeyUsage': 'SIGN_VERIFY',
                'SigningAlgorithms': ['ECDSA_SHA_256'], 'PublicKey': base64.b64encode(SPKI).decode()}
        raise AssertionError('unexpected fake API operation')

class OrderedSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name); self.root = key.private_directory(self.base / 'private')
        self.config = self.base / '.aws' / 'config'; self.config.parent.mkdir(mode=0o700)
        self.original = b'# Keep comments and SSO configuration\n[profile bootstrap]\nregion = eu-west-1\n'
        self.config.write_bytes(self.original); self.config.chmod(0o600)
        self.environment = patch.dict(os.environ, {'AWS_CONFIG_FILE': str(self.config)}); self.environment.start()
        self.aws = FakeAws()
    def tearDown(self): self.environment.stop(); self.temp.cleanup()
    def plan(self): return m.make_plan(self.root, self.aws, 'bootstrap', self.config)
    def roles(self):
        plan = self.plan(); m.provision_roles(self.root, self.aws, plan, lambda _: True); return plan
    def mutations(self): return [v for v in self.aws.calls if v[2] in {'create-role', 'put-role-policy', 'create-key'}]

    def test_three_roles_exact_trust_and_permissions_then_rerun(self):
        plan = self.roles()
        self.assertEqual(len(self.aws.roles), 3)
        self.assertEqual(len(self.aws.policies), 1)
        self.assertEqual(len(self.mutations()), 4)
        for label, role in plan['roles'].items():
            created = self.aws.roles[role['name']]
            self.assertEqual(created['AssumeRolePolicyDocument'], m.trust_policy(PRINCIPAL))
            self.assertEqual(created['MaxSessionDuration'], 3600)
            self.assertNotIn('Service', created['AssumeRolePolicyDocument']['Statement'][0]['Principal'])
        m.provision_roles(self.root, self.aws, m.load_plan(self.root), lambda _: self.fail('must not reprompt'))
        self.assertEqual(len(self.mutations()), 4)

    def test_bootstrap_can_be_an_existing_federated_role_but_not_root_or_service_role(self):
        name = 'ExistingOperator'
        self.aws.principal = ':'.join(['arn', 'aws', 'sts', '', ACCOUNT, 'assumed-role/' + name + '/test'])
        canonical = ':'.join(['arn', 'aws', 'iam', '', ACCOUNT, 'role/operators/' + name])
        self.aws.roles[name] = {'RoleName': name, 'Arn': canonical,
            'AssumeRolePolicyDocument': {'Statement': [{'Principal': {'Federated': 'private-reference'}}]}}
        plan = self.plan()
        self.assertEqual(plan['trust']['Statement'][0]['Principal']['AWS'], canonical)
        self.aws.roles[name]['AssumeRolePolicyDocument']['Statement'][0]['Principal'] = {'Service': 'ec2.amazonaws.com'}
        with self.assertRaisesRegex(key.Refused, 'SERVICE_ROLE'): m.bootstrap(self.aws, 'bootstrap')
        self.aws.principal = ':'.join(['arn', 'aws', 'iam', '', ACCOUNT, 'root'])
        with self.assertRaisesRegex(key.Refused, 'NOT_ROOT'): m.bootstrap(self.aws, 'bootstrap')

    def test_completed_role_step_is_verification_only_even_when_permissions_missing(self):
        plan = self.roles()
        self.aws.policies.clear()
        def execute(command, **kwargs):
            profile = command[command.index('--profile') + 1]
            request = json.loads(Path(command[command.index('--cli-input-json') + 1][7:]).read_text()) if '--cli-input-json' in command else None
            value = self.aws.call(profile, command[1], command[2], request)
            return subprocess.CompletedProcess(command, 0, json.dumps(value).encode(), b'')
        before = len(self.mutations())
        with patch.object(sys.stdin, 'isatty', return_value=True), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(m.main(['roles', '--directory', str(self.root)], execute), 1)
        self.assertEqual(len(self.mutations()), before)

    def test_administrator_create_key_permission_is_constrained_and_role_reads_scoped(self):
        plan = self.plan(); statements = plan['administratorPolicy']['Statement']
        self.assertEqual(statements[0]['Action'], 'kms:CreateKey')
        self.assertEqual(statements[0]['Condition']['StringEquals']['kms:KeySpec'], 'ECC_SECG_P256K1')
        self.assertEqual(statements[0]['Condition']['Bool']['kms:BypassPolicyLockoutSafetyCheck'], 'false')
        self.assertEqual(set(statements[1]['Resource']), {role['arn'] for role in plan['roles'].values()})
        self.assertNotIn('kms:Sign', json.dumps(plan['administratorPolicy']))

    def test_existing_role_or_profile_collision_changes_nothing(self):
        self.aws.roles[m.NAMES['signing']] = {'foreign': True}
        with self.assertRaisesRegex(key.Refused, 'ALREADY_EXISTS'): self.plan()
        self.assertFalse(self.mutations())
        self.aws.roles.clear(); self.aws.inventory.append(m.PROFILES['signing'])
        with self.assertRaisesRegex(key.Refused, 'PROFILE_COLLISION'): self.plan()
        self.assertFalse(self.mutations())

    def test_confirmation_rejection_does_not_mutate_aws(self):
        plan = self.plan()
        with self.assertRaisesRegex(key.Refused, 'CANCELLED'): m.provision_roles(self.root, self.aws, plan, lambda _: False)
        self.assertFalse(self.mutations())

    def test_changed_bootstrap_or_approved_plan_refused(self):
        plan = self.plan(); self.aws.principal = PRINCIPAL + '-changed'
        with self.assertRaisesRegex(key.Refused, 'IDENTITY_CHANGED'): m.provision_roles(self.root, self.aws, plan, lambda _: True)
        self.assertFalse(self.mutations())
        self.aws.principal = PRINCIPAL; m.provision_roles(self.root, self.aws, plan, lambda _: True)
        edited = key.read_private(self.root, 'roles-plan.json'); edited['bootstrapProfile'] = 'other'
        (self.root / 'roles-plan.json').write_bytes(key.encoded(edited))
        with self.assertRaisesRegex(key.Refused, 'PLAN_CHANGED'): m.load_plan(self.root)

    def test_ambiguous_create_is_reconciled_by_tags_and_never_recreated(self):
        plan = self.plan(); self.aws.failure = 'create-role'
        with self.assertRaises(key.Refused): m.provision_roles(self.root, self.aws, plan, lambda _: True)
        self.assertEqual(len(self.aws.roles), 1)
        self.aws.failure = None
        m.provision_roles(self.root, self.aws, plan, lambda _: True)
        self.assertEqual(len([c for c in self.aws.calls if c[2] == 'create-role']), 3)

    def test_uncertain_create_still_absent_is_not_retried(self):
        plan = self.plan(); self.aws.failure = 'create-role'
        with self.assertRaises(key.Refused): m.provision_roles(self.root, self.aws, plan, lambda _: True)
        self.aws.hidden.add(m.NAMES['administrator']); self.aws.failure = None
        with self.assertRaisesRegex(key.Refused, 'UNCERTAIN'): m.provision_roles(self.root, self.aws, plan, lambda _: True)
        self.assertEqual(len([c for c in self.aws.calls if c[2] == 'create-role']), 1)

    def test_unknown_policy_write_reconciles_without_another_write(self):
        plan = self.plan(); self.aws.failure = 'put-role-policy'
        with self.assertRaises(key.Refused): m.provision_roles(self.root, self.aws, plan, lambda _: True)
        self.aws.failure = None; m.provision_roles(self.root, self.aws, plan, lambda _: True)
        self.assertEqual(len([c for c in self.aws.calls if c[2] == 'put-role-policy']), 1)

    def test_foreign_tags_or_extra_permissions_stop_without_policy_overwrite(self):
        plan = self.roles(); self.aws.roles[m.NAMES['recovery']]['Tags'] = []
        with self.assertRaisesRegex(key.Refused, 'DRIFT'): m.verify_roles(self.root, self.aws, plan)
        self.aws.roles[m.NAMES['recovery']]['Tags'] = m.tags(plan, 'recovery')
        self.aws.policies[m.NAMES['administrator']] = {'unexpected': True}
        with self.assertRaisesRegex(key.Refused, 'POLICY_DRIFT'): m.provision_roles(self.root, self.aws, plan, lambda _: True)
        self.assertEqual(len(self.mutations()), 4)

    def test_profiles_preserve_original_config_and_back_up_privately(self):
        plan = self.roles(); m.install_profiles(self.root, plan, lambda _: True)
        self.assertTrue(self.config.read_bytes().startswith(self.original))
        self.assertEqual(key.read_private(self.root, 'aws-config-backup.json')['bytes'].encode(), self.original)
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o600)
        m.verify_profiles(self.root, plan)
        once = self.config.read_bytes(); m.install_profiles(self.root, plan, lambda _: self.fail('no reprompt'))
        self.assertEqual(self.config.read_bytes(), once)
        cfg = m.parse_config(once)
        for name in m.PROFILES.values(): self.assertEqual(cfg.get('profile ' + name, 'source_profile'), 'bootstrap')

    def test_profile_conflict_or_edit_during_review_preserves_existing_file(self):
        plan = self.roles()
        self.config.write_bytes(self.original + ('\n[profile ' + m.PROFILES['signing'] + ']\nregion = other\n').encode())
        with self.assertRaisesRegex(key.Refused, 'COLLISION'): m.install_profiles(self.root, plan, lambda _: True)
        self.config.write_bytes(self.original)
        def confirm(_): self.config.write_bytes(self.original + b'\n# operator edit\n'); return True
        with self.assertRaisesRegex(key.Refused, 'CHANGED_DURING_REVIEW'): m.install_profiles(self.root, plan, confirm)
        self.assertTrue(self.config.read_bytes().endswith(b'# operator edit\n'))

    def test_profile_symlink_or_stale_lock_refused(self):
        plan = self.roles(); lock = Path(str(self.config) + '.kamui-lock'); lock.write_text('stale')
        with self.assertRaises(FileExistsError): m.install_profiles(self.root, plan, lambda _: True)
        lock.unlink(); target = self.config.with_name('target'); self.config.rename(target); self.config.symlink_to(target)
        with self.assertRaises(OSError): m.install_profiles(self.root, plan, lambda _: True)
        self.assertEqual(target.read_bytes(), self.original)

    def test_role_transport_preserves_only_typed_not_found_without_printing_errors(self):
        def execute(command, **kwargs):
            return subprocess.CompletedProcess(command, 1, b'', b'An error occurred (NoSuchEntity) when calling the GetRole operation: private')
        with self.assertRaises(key.AwsServiceError) as caught: m.RoleAws(self.root, execute).call('bootstrap', 'iam', 'get-role', {'RoleName': 'missing'})
        self.assertEqual(caught.exception.code, 'NoSuchEntity')
        self.assertNotIn('private', str(caught.exception).lower().replace('private_logs_retained',''))

    def test_successful_empty_iam_policy_write_is_not_json_failure(self):
        def execute(command, **kwargs): return subprocess.CompletedProcess(command, 0, b'', b'')
        self.assertEqual(m.RoleAws(self.root, execute).call('bootstrap', 'iam', 'put-role-policy', {}), {})
        with self.assertRaises(json.JSONDecodeError): m.RoleAws(self.root, execute).call('bootstrap', 'iam', 'get-role', {})

    def test_authentication_error_is_not_mistaken_for_missing_role(self):
        def execute(command, **kwargs):
            return subprocess.CompletedProcess(command, 1, b'', b'An error occurred (NoSuchEntity) when calling the AssumeRole operation')
        with self.assertRaises(key.Refused) as caught: m.RoleAws(self.root, execute).call('bootstrap', 'iam', 'get-role', {'RoleName': 'missing'})
        self.assertNotIsInstance(caught.exception, key.AwsServiceError)

    def test_existing_key_attempt_blocks_role_bootstrap(self):
        key.write_private(self.root, 'creation-attempt.json', {'uncertain': True})
        with self.assertRaisesRegex(key.Refused, 'RECONCILIATION'): self.plan()
        self.assertFalse(self.mutations())

    def test_all_three_cli_steps_with_fake_aws_and_repeat_do_not_duplicate(self):
        def execute(command, **kwargs):
            if command[1:3] == ['configure', 'list-profiles']: value = b'bootstrap\n'
            else:
                profile = command[command.index('--profile') + 1]
                request = json.loads(Path(command[command.index('--cli-input-json') + 1][7:]).read_text()) if '--cli-input-json' in command else None
                try: result = self.aws.call(profile, command[1], command[2], request)
                except key.AwsServiceError:
                    return subprocess.CompletedProcess(command, 1, b'', b'An error occurred (NoSuchEntity) when calling the GetRole operation')
                value = b'' if command[2] == 'put-role-policy' else json.dumps(result).encode()
            return subprocess.CompletedProcess(command, 0, value, b'')
        def answer(prompt):
            if prompt.startswith('Bootstrap'): return '1'
            if prompt.startswith('Type CREATE ROLES'): return 'CREATE ROLES ' + key.digest(key.read_private(self.root, 'roles-plan.json'))[:12]
            if prompt.startswith('Type ADD PROFILES'):
                plan = m.load_plan(self.root); old = self.config.read_bytes()
                new = old + (b'' if not old or old.endswith(b'\n') else b'\n') + m.profile_text(plan)
                return 'ADD PROFILES ' + m.sha(new)[:12]
            if prompt.startswith('Type CREATE'): return 'CREATE ' + key.read_private(self.root, 'setup-config.json')['policySha256'][:12]
            self.fail('unexpected prompt')
        output, error = io.StringIO(), io.StringIO()
        with patch.object(sys.stdin, 'isatty', return_value=True), patch('builtins.input', side_effect=answer), redirect_stdout(output), redirect_stderr(error):
            for step in ['roles', 'profiles', 'key', 'roles', 'profiles', 'key']:
                result = m.main([step, '--directory', str(self.root)], execute)
                self.assertEqual(result, 0, error.getvalue())
        self.assertEqual(len([c for c in self.aws.calls if c[2] == 'create-role']), 3)
        self.assertEqual(len([c for c in self.aws.calls if c[2] == 'create-key']), 1)
        self.assertNotIn(PRINCIPAL, output.getvalue() + error.getvalue())
        self.assertNotIn(ACCOUNT, output.getvalue() + error.getvalue())
        self.assertEqual(key.read_private(self.root, 'setup-config.json')['profiles'], m.PROFILES)
        self.assertTrue((self.root / 'admin-public-key.json').exists())

if __name__ == '__main__': unittest.main()
