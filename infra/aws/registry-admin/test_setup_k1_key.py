"""All AWS calls are fakes. No credentials, real identifiers or private keys used."""
import base64
from contextlib import redirect_stdout, redirect_stderr
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('setup', Path(__file__).with_name('setup_k1_key.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
ACCOUNT = '0' * 12
PROFILES = dict(zip(m.LABELS, ('admin', 'recovery', 'signer')))
def role(name): return ':'.join(['arn', 'aws', 'iam', '', ACCOUNT, 'role/team/' + name])
def arn(name): return ':'.join(['arn', 'aws', 'sts', '', ACCOUNT, 'assumed-role/' + name + '/test'])
KEY = ':'.join(['arn', 'aws', 'kms', m.REGION, ACCOUNT, 'key/' + '0' * 8 + '-0000-0000-0000-' + '0' * 12])
# Standard secp256k1 generator: public test point, not a signing key.
POINT = bytes.fromhex('0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
                      '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8')
SPKI = bytes.fromhex('3056301006072a8648ce3d020106052b8104000a034200') + POINT

def metadata():
    return {'KeyMetadata': {'Arn': KEY, 'AWSAccountId': ACCOUNT, 'KeySpec': 'ECC_SECG_P256K1',
        'KeyUsage': 'SIGN_VERIFY', 'Origin': 'AWS_KMS', 'KeyState': 'Enabled', 'KeyManager': 'CUSTOMER', 'MultiRegion': False}}

class FakeAws:
    def __init__(self): self.calls = []; self.create_failure = False; self.change = None; self.public = SPKI
    def call(self, profile, service, operation, request=None):
        self.calls.append((profile, service, operation, request))
        if (service, operation) == ('sts', 'get-caller-identity'):
            name = self.change if self.change and profile == 'admin' else profile
            return {'Account': ACCOUNT, 'Arn': arn(name)}
        if (service, operation) == ('iam', 'get-role'):
            return {'Role': {'Arn': role(request['RoleName']), 'RoleName': request['RoleName'],
                'AssumeRolePolicyDocument': {'Statement': [{'Principal': {'AWS': 'private-reference'}}]}}}
        if (service, operation) == ('kms', 'create-key'):
            if self.create_failure: raise m.Refused('AWS_REQUEST_UNCERTAIN_PRIVATE_LOGS_RETAINED')
            return metadata()
        if (service, operation) == ('kms', 'get-public-key'):
            return {'KeyId': KEY, 'KeySpec': 'ECC_SECG_P256K1', 'KeyUsage': 'SIGN_VERIFY',
                'SigningAlgorithms': ['ECDSA_SHA_256'], 'PublicKey': base64.b64encode(self.public).decode()}
        raise AssertionError('Unexpected fake operation')

class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = m.private_directory(Path(self.temp.name) / 'private')
        self.aws = FakeAws()
    def tearDown(self): self.temp.cleanup()
    def prepared(self): return m.prepare(self.root, self.aws, PROFILES)
    def creates(self): return [c for c in self.aws.calls if c[1:3] == ('kms', 'create-key')]

    def test_complete_flow_and_minimal_creation_request(self):
        config = self.prepared()
        self.assertEqual(m.status(self.root), 'POLICY_PREPARED_NO_KEY_CREATED')
        m.create(self.root, self.aws, lambda sha: sha == config['policySha256'])
        m.export_public(self.root, self.aws)
        self.assertEqual(m.status(self.root), 'KEY_PUBLIC_METADATA_SAVED')
        self.assertEqual(len(self.creates()), 1)
        request = self.creates()[0][3]
        self.assertEqual(request['KeySpec'], 'ECC_SECG_P256K1')
        self.assertEqual(request['KeyUsage'], 'SIGN_VERIFY')
        self.assertEqual(request['Origin'], 'AWS_KMS')
        self.assertIs(request['MultiRegion'], False)
        self.assertIs(request['BypassPolicyLockoutSafetyCheck'], False)
        self.assertTrue((self.root / 'creation-attempt.json').exists())
        self.assertTrue(all(c[0] == 'admin' for c in self.aws.calls if c[1] == 'iam'))
        for file in self.root.iterdir(): self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)

    def test_declined_confirmation_sends_nothing_and_can_confirm_later(self):
        self.prepared()
        with self.assertRaisesRegex(m.Refused, 'CANCELLED'): m.create(self.root, self.aws, lambda _: False)
        self.assertFalse((self.root / 'creation-attempt.json').exists())
        self.assertFalse(self.creates())
        m.create(self.root, self.aws, lambda _: True)

    def test_creation_uncertainty_survives_restart_and_cannot_retry(self):
        self.prepared(); self.aws.create_failure = True
        with self.assertRaises(m.Refused): m.create(self.root, self.aws, lambda _: True)
        self.assertEqual(m.status(self.root), 'KEY_CREATION_UNCERTAIN_DO_NOT_RETRY')
        self.aws.create_failure = False
        with self.assertRaisesRegex(m.Refused, 'ALREADY_ATTEMPTED'): m.create(self.root, self.aws, lambda _: True)
        self.assertEqual(len(self.creates()), 1)

    def test_creation_intent_is_durable_before_aws_call(self):
        self.prepared(); original = self.aws.call
        def call(profile, service, operation, request=None):
            if operation == 'create-key':
                self.assertEqual(m.read_private(self.root, 'creation-attempt.json')['request'], request)
            return original(profile, service, operation, request)
        self.aws.call = call
        m.create(self.root, self.aws, lambda _: True)

    def test_completed_creation_cannot_create_again(self):
        self.prepared(); m.create(self.root, self.aws, lambda _: True)
        with self.assertRaises(m.Refused): m.create(self.root, self.aws, lambda _: True)
        self.assertEqual(len(self.creates()), 1)

    def test_profile_drift_and_policy_edit_refuse_before_creation(self):
        self.prepared(); self.aws.change = 'unexpected'
        with self.assertRaisesRegex(m.Refused, 'IDENTITY_CHANGED'): m.create(self.root, self.aws, lambda _: True)
        self.aws.change = None
        (self.root / 'key-policy.json').write_text('{}')
        with self.assertRaisesRegex(m.Refused, 'POLICY_CHANGED'): m.create(self.root, self.aws, lambda _: True)
        self.assertFalse(self.creates())

    def test_profile_change_during_confirmation_refuses_creation(self):
        self.prepared()
        def confirm(_):
            self.aws.change = 'changed-during-prompt'
            return True
        with self.assertRaisesRegex(m.Refused, 'IDENTITY_CHANGED'): m.create(self.root, self.aws, confirm)
        self.assertFalse(self.creates())
        self.assertFalse((self.root / 'creation-attempt.json').exists())

    def test_same_role_and_service_roles_refused(self):
        with self.assertRaisesRegex(m.Refused, 'DISTINCT'): m.prepare(self.root, self.aws, dict.fromkeys(m.LABELS, 'admin'))
        original = self.aws.call
        def service_role(*args):
            value = original(*args)
            if 'Role' in value: value['Role']['AssumeRolePolicyDocument']['Statement'][0]['Principal'] = {'Service': 'ec2.amazonaws.com'}
            return value
        self.aws.call = service_role
        with self.assertRaisesRegex(m.Refused, 'SERVICE_ROLE'): self.prepared()

    def test_cross_account_profile_refused_before_key_creation(self):
        original = self.aws.call
        def another_account(profile, service, operation, request=None):
            value = original(profile, service, operation, request)
            if profile == 'signer' and operation == 'get-caller-identity':
                value = {key: val.replace(ACCOUNT, '1' * 12) for key, val in value.items()}
            return value
        self.aws.call = another_account
        with self.assertRaises(m.Refused): self.prepared()
        self.assertFalse(self.creates())
        self.assertFalse((self.root / 'setup-config.json').exists())

    def test_wrong_public_curve_point_rejected_without_overwrite(self):
        self.prepared(); m.create(self.root, self.aws, lambda _: True)
        self.aws.public = SPKI[:-1] + bytes([SPKI[-1] ^ 1])
        with self.assertRaisesRegex(m.Refused, 'ENCODING'): m.export_public(self.root, self.aws)
        self.assertFalse((self.root / 'admin-public-key.json').exists())
        self.aws.public = SPKI; m.export_public(self.root, self.aws)
        with self.assertRaises(FileExistsError): m.export_public(self.root, self.aws)

    def test_owner_modes_symlinks_repository_and_exclusive_files(self):
        os.chmod(self.root, 0o755)
        with self.assertRaises(m.Refused): m.private_directory(self.root)
        os.chmod(self.root, 0o700)
        link = Path(self.temp.name) / 'link'; link.symlink_to(self.root)
        with self.assertRaises(m.Refused): m.private_directory(link)
        with self.assertRaises(m.Refused): m.private_directory(m.REPO / 'private-forbidden')
        m.write_private(self.root, 'file.json', {})
        with self.assertRaises(FileExistsError): m.write_private(self.root, 'file.json', {})
        os.chmod(self.root / 'file.json', 0o644)
        with self.assertRaises(m.Refused): m.read_private(self.root, 'file.json')

    def test_cli_is_single_attempt_private_file_request_and_never_prints_aws_output(self):
        commands = []
        def execute(command, **options):
            commands.append((command, options))
            return subprocess.CompletedProcess(command, 0, json.dumps({'KeyId': KEY}).encode(), KEY.encode())
        aws = m.Aws(self.root, execute)
        output, error = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(error):
            aws.call('admin', 'kms', 'get-public-key', {'KeyId': KEY})
        command, options = commands[0]
        self.assertNotIn(KEY, ' '.join(command))
        request_path = Path(command[command.index('--cli-input-json') + 1][7:])
        self.assertEqual(json.loads(request_path.read_text())['KeyId'], KEY)
        self.assertEqual(request_path.stat().st_mode & 0o777, 0o600)
        self.assertIsNone(options['input'])
        self.assertEqual(options['env']['AWS_MAX_ATTEMPTS'], '1')
        self.assertEqual(options['env']['AWS_IGNORE_CONFIGURED_ENDPOINT_URLS'], 'true')
        self.assertNotIn('AWS_ACCESS_KEY_ID', options['env'])
        self.assertEqual(output.getvalue() + error.getvalue(), '')

    def test_cli_timeout_retains_private_diagnostics(self):
        def execute(*args, **kwargs): raise subprocess.TimeoutExpired('aws', 45, output=b'', stderr=KEY.encode())
        aws = m.Aws(self.root, execute)
        with self.assertRaisesRegex(m.Refused, 'UNCERTAIN'): aws.call('admin', 'kms', 'create-key', {})
        self.assertTrue(list(self.root.glob('aws-*.stderr')))

    def test_read_timeout_retries_safely_and_records_operation(self):
        calls = []
        def execute(command, **kwargs):
            calls.append(command)
            if len(calls) == 1: raise subprocess.TimeoutExpired('aws', 45)
            return subprocess.CompletedProcess(command, 0, b'{}', b'')
        error = io.StringIO()
        with redirect_stderr(error): m.Aws(self.root, execute).call('admin', 'iam', 'get-role', {'RoleName': 'test'})
        self.assertEqual(len(calls), 2)
        self.assertIn('AWS_READ_RETRY iam:get-role attempt 2/3', error.getvalue())
        records = [json.loads(p.read_text()) for p in self.root.glob('aws-*.call.json')]
        self.assertEqual(sorted(v['attempt'] for v in records), [1, 2])
        self.assertTrue(all(v['readOnly'] and v['operation'] == 'get-role' for v in records))
        self.assertNotIn(KEY, error.getvalue())
        self.assertIn('--cli-read-timeout', calls[0])
        self.assertEqual(calls[0][calls[0].index('--cli-read-timeout') + 1], '15')

    def test_exhausted_read_timeout_is_not_creation_uncertainty(self):
        calls = []
        def execute(command, **kwargs):
            calls.append(command); raise subprocess.TimeoutExpired('aws', 45)
        with redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(m.Refused, 'AWS_READ_TIMEOUT iam:get-role'):
                m.Aws(self.root, execute).call('admin', 'iam', 'get-role', {'RoleName': 'test'})
        self.assertEqual(len(calls), 3)
        self.assertFalse((self.root / 'creation-attempt.json').exists())

    def test_mutation_timeout_never_retries_and_identifies_operation(self):
        calls = []
        def execute(command, **kwargs):
            calls.append(command); raise subprocess.TimeoutExpired('aws', 45)
        with self.assertRaisesRegex(m.Refused, 'AWS_MUTATION_UNCERTAIN kms:create-key'):
            m.Aws(self.root, execute).call('admin', 'kms', 'create-key', {})
        self.assertEqual(len(calls), 1)
        record = json.loads(next(self.root.glob('aws-*.call.json')).read_text())
        self.assertFalse(record['readOnly'])
        self.assertEqual(record['maximumAttempts'], 1)

    def test_cli_read_socket_timeout_retries_but_auth_failure_does_not(self):
        calls = []
        def execute(command, **kwargs):
            calls.append(command)
            if len(calls) == 1: return subprocess.CompletedProcess(command, 255, b'', b'Read timeout on endpoint URL: private-url')
            return subprocess.CompletedProcess(command, 0, b'{}', b'')
        with redirect_stderr(io.StringIO()): m.Aws(self.root, execute).call('admin', 'iam', 'get-role', {})
        self.assertEqual(len(calls), 2)
        calls.clear()
        def denied(command, **kwargs):
            calls.append(command)
            return subprocess.CompletedProcess(command, 1, b'', b'An error occurred (AccessDenied) when calling the GetRole operation: private')
        with self.assertRaisesRegex(m.Refused, 'AWS_READ_FAILED iam:get-role'):
            m.Aws(self.root, denied).call('admin', 'iam', 'get-role', {})
        self.assertEqual(len(calls), 1)

    def test_turnkey_cli_twice_creates_only_one_key_and_resumes_export(self):
        aws = self.aws
        def execute(command, **kwargs):
            if command[1:3] == ['configure', 'list-profiles']:
                value = b'admin\nrecovery\nsigner\n'
            else:
                profile = command[command.index('--profile') + 1]
                request = json.loads(Path(command[command.index('--cli-input-json') + 1][7:]).read_text()) if '--cli-input-json' in command else None
                value = json.dumps(aws.call(profile, command[1], command[2], request)).encode()
            return subprocess.CompletedProcess(command, 0, value, b'')
        choices = iter(['1', '2', '3'])
        def answer(prompt):
            if prompt.startswith('Type CREATE'):
                return 'CREATE ' + m.read_private(self.root, 'setup-config.json')['policySha256'][:12]
            return next(choices)
        output, error = io.StringIO(), io.StringIO()
        with patch.object(m.sys.stdin, 'isatty', return_value=True), patch('builtins.input', side_effect=answer), redirect_stdout(output), redirect_stderr(error):
            # select_profiles defaults are bound at definition, so inject the scripted selector.
            original = m.select_profiles
            with patch.object(m, 'select_profiles', side_effect=lambda client: original(client, ask=answer)):
                self.assertEqual(m.main(['setup', '--directory', str(self.root)], execute), 0)
                self.assertEqual(m.main(['setup', '--directory', str(self.root)], execute), 0)
        self.assertEqual(len(self.creates()), 1)
        self.assertNotIn(KEY, output.getvalue() + error.getvalue())
        self.assertNotIn(ACCOUNT, output.getvalue() + error.getvalue())

    @unittest.skipUnless(shutil.which('aws'), 'AWS CLI not installed')
    def test_real_cli_can_parse_private_request_without_any_aws_account_call(self):
        request = self.root / 'offline-request.json'
        m.write_private(self.root, request.name, {'RoleName': 'OfflineParserCheck'})
        result = subprocess.run(['aws', 'iam', 'get-role', '--generate-cli-skeleton', 'input',
            '--cli-input-json', 'file://' + str(request), '--no-sign-request', '--no-cli-pager'],
            capture_output=True, timeout=15, env=dict(os.environ, AWS_EC2_METADATA_DISABLED='true'))
        self.assertEqual(result.returncode, 0, 'Local AWS CLI JSON parsing failed')
        self.assertEqual(set(json.loads(result.stdout)), {'RoleName'})

    def test_status_command_local_only_and_errors_redacted(self):
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(m.main(['status', '--directory', str(self.root)], lambda *_a, **_k: self.fail('must be local')), 0)
        self.assertEqual(output.getvalue().strip(), 'SETUP_NOT_PREPARED')

if __name__ == '__main__': unittest.main()
