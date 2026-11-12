"""Failure/restart boundaries of operator setup; all AWS calls are mocked."""
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import test_integration as integration


class SetupSafetyTest(unittest.TestCase):
    def fixture(self, directory):
        return integration.ResourceIntegrationTest.fixture(self, directory)

    def test_partial_selected_network_is_refused_before_aws(self):
        with tempfile.TemporaryDirectory() as d:
            _, setup, aws, root, _, initial = self.fixture(d)
            initial['backend']['subnet_id'] = 'subnet-0123456789abcdef0'
            (root/'aws-input.json').write_text(json.dumps(initial))
            with self.assertRaisesRegex(ValueError, 'PARTIAL_RESOURCE_SELECTION_REFUSED'): setup.prepare()
            self.assertEqual(aws.calls, [])

    def test_selected_network_is_verified_before_any_stack_can_be_created(self):
        with tempfile.TemporaryDirectory() as d:
            _, setup, aws, root, _, initial = self.fixture(d)
            initial['backend'].update(subnet_id='subnet-0123456789abcdef0', security_group_id='sg-0123456789abcdef0')
            (root/'aws-input.json').write_text(json.dumps(initial))
            original = aws.request
            def call(profile, service, operation, inputs):
                result = original(profile, service, operation, inputs)
                if operation == 'describe-security-groups': result['SecurityGroups'][0]['IpPermissions'].append({'IpProtocol': '-1'})
                return result
            aws.request = call
            with self.assertRaisesRegex(ValueError, 'SELECTED_NETWORK_MISMATCH'): setup.prepare()
            self.assertFalse(any(c[2] == 'create-stack' for c in aws.calls))

    def test_prepared_official_ami_is_not_reresolved_on_restart(self):
        with tempfile.TemporaryDirectory() as d:
            _, setup, aws, _, _, _ = self.fixture(d)
            setup.prepare()
            before = sum(c[2] == 'get-parameter' for c in aws.calls)
            setup.prepare()
            self.assertEqual(sum(c[2] == 'get-parameter' for c in aws.calls), before)

    def test_preexisting_complete_selections_are_reused_without_new_stacks(self):
        with tempfile.TemporaryDirectory() as d:
            module, setup, aws, root, _, _ = self.fixture(d)
            setup.prepare(); setup.network(); setup.identity(); setup.export()
            config = json.loads((root/'aws-input.json').read_text())
            other = Path(d).resolve()/'preselected'; other.mkdir(mode=0o700)
            module.write_private(other/'aws-input.json', config)
            existing = module.Setup(other, aws, setup.backend_record, setup.pepper_env, polls=1)
            count = sum(c[2] == 'create-stack' for c in aws.calls)
            existing.prepare(); existing.network(); existing.identity(); existing.export()
            self.assertEqual(sum(c[2] == 'create-stack' for c in aws.calls), count)

    def test_uncertain_create_with_no_visible_stack_never_resubmits(self):
        with tempfile.TemporaryDirectory() as d:
            module, setup, aws, _, _, _ = self.fixture(d)
            setup.prepare(); original = aws.request
            def call(profile, service, operation, inputs):
                if operation == 'create-stack':
                    aws.calls.append((profile, service, operation, copy.deepcopy(inputs)))
                    raise module.AwsError('AWS_REQUEST_UNCERTAIN', True)
                return original(profile, service, operation, inputs)
            aws.request = call
            with self.assertRaises(module.AwsError): setup.network()
            with self.assertRaisesRegex(ValueError, 'STACK_SUBMISSION_UNCERTAIN_RECONCILE_ONLY'): setup.network()
            self.assertEqual(sum(c[2] == 'create-stack' for c in aws.calls), 1)

    def test_export_rechecks_owned_stack_template_before_using_saved_outputs(self):
        with tempfile.TemporaryDirectory() as d:
            _, setup, aws, root, _, initial = self.fixture(d)
            setup.prepare(); setup.network(); setup.identity()
            next(iter(aws.templates.values()))['Description'] = 'changed-after-creation'
            with self.assertRaisesRegex(ValueError, 'DEPLOYED_TEMPLATE_MISMATCH'): setup.export()
            self.assertEqual(json.loads((root/'aws-input.json').read_text()), initial)

    def test_export_is_read_only_when_resource_phases_have_not_run(self):
        with tempfile.TemporaryDirectory() as d:
            _, setup, aws, _, _, _ = self.fixture(d)
            setup.prepare()
            with self.assertRaises(FileNotFoundError): setup.export()
            self.assertFalse(any(c[2] == 'create-stack' for c in aws.calls))

    def test_unproven_pepper_key_policy_is_not_rewritten_or_accepted(self):
        with tempfile.TemporaryDirectory() as d:
            _, setup, aws, root, _, initial = self.fixture(d)
            setup.prepare(); setup.network(); setup.identity(); original = aws.request
            def call(profile, service, operation, inputs):
                if operation == 'get-key-policy': return {'Policy': json.dumps({'Statement': []})}
                return original(profile, service, operation, inputs)
            aws.request = call
            with self.assertRaisesRegex(ValueError, 'PEPPER_KEY_POLICY_REVIEW_REQUIRED'): setup.export()
            self.assertEqual(json.loads((root/'aws-input.json').read_text()), initial)
            self.assertFalse(any(c[2] == 'put-key-policy' for c in aws.calls))

    def test_aws_transport_uses_private_files_single_attempt_and_redacted_errors(self):
        module = integration.load_runner()
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d).resolve()
            client = module.Aws(directory)
            def execute(command, **kwargs):
                env = kwargs['env']
                self.assertEqual(env['AWS_MAX_ATTEMPTS'], '1')
                self.assertNotIn('AWS_ACCESS_KEY_ID', env)
                self.assertNotIn('AWS_ENDPOINT_URL', env)
                request = Path(command[command.index('--cli-input-json')+1].removeprefix('file://'))
                self.assertEqual(request.stat().st_mode & 0o777, 0o600)
                self.assertEqual(json.loads(request.read_text()), {})
                return subprocess.CompletedProcess(command, 1, b'', b'PRIVATE_FAILURE_SENTINEL')
            with patch.dict(os.environ, {'AWS_ACCESS_KEY_ID': 'PRIVATE_SENTINEL', 'AWS_ENDPOINT_URL': 'https://invalid.test'}), patch.object(module.subprocess, 'run', side_effect=execute):
                with self.assertRaises(module.AwsError) as error: client.request('fixture', 'sts', 'get-caller-identity', {})
            self.assertEqual(str(error.exception), 'AWS_STS_GET_CALLER_IDENTITY_FAILED')
            self.assertTrue(any(b'PRIVATE_FAILURE_SENTINEL' in p.read_bytes() for p in directory.glob('*-stderr')))

    def test_transport_cannot_read_private_parameters_secrets_or_change_key_policy(self):
        module = integration.load_runner()
        with tempfile.TemporaryDirectory() as d, patch.object(module.subprocess, 'run') as run:
            client = module.Aws(Path(d).resolve())
            for service, operation, inputs in [('ssm', 'get-parameter', {'Name': '/private', 'WithDecryption': True}),
                    ('secretsmanager', 'get-secret-value', {}), ('kms', 'put-key-policy', {})]:
                with self.assertRaises(ValueError): client.request('fixture', service, operation, inputs)
            run.assert_not_called()

    def test_private_source_permissions_and_duplicate_pepper_reference_are_refused(self):
        with tempfile.TemporaryDirectory() as d:
            _, setup, aws, _, _, _ = self.fixture(d)
            setup.backend_record.chmod(0o644)
            with self.assertRaisesRegex(ValueError, 'PRIVATE_FILE_REQUIRED'): setup.prepare()
            setup.backend_record.chmod(0o600)
            setup.pepper_env.write_text(setup.pepper_env.read_text()*2)
            with self.assertRaisesRegex(ValueError, 'EXISTING_PEPPER_KEY_REQUIRED'): setup.prepare()
            self.assertEqual(aws.calls, [])

    def test_host_phase_reuses_verified_launches_instead_of_submitting_again(self):
        with tempfile.TemporaryDirectory() as d:
            module, setup, _, root, _, _ = self.fixture(d)
            setup.prepare(); setup.network(); setup.identity(); setup.export()
            calls = []
            def launch(values):
                role = values['KAMUI_ROLE']; calls.append(role)
                module.write_private(root/(role+'-launch')/(role+'-launch-intent.json'), {'fixture': True})
            reader_calls = []
            def reader(_root, role, _config, _aws): reader_calls.append(role); return {'InstanceId': 'fixture'}
            setup.launch(provision_run=launch, instance_reader=reader)
            setup.launch(provision_run=launch, instance_reader=reader)
            self.assertEqual(calls, ['backend', 'pepper'])
            self.assertEqual(reader_calls, ['backend', 'pepper'])

    def test_uncertain_host_launch_cannot_be_retried_even_if_result_is_missing(self):
        with tempfile.TemporaryDirectory() as d:
            module, setup, _, root, _, _ = self.fixture(d)
            setup.prepare(); setup.network(); setup.identity(); setup.export()
            attempts = []
            def launch(values):
                attempts.append(values['KAMUI_ROLE'])
                module.write_private(root/'backend-launch/backend-launch-intent.json', {'fixture': True})
                raise subprocess.TimeoutExpired('fake', 1)
            def missing(*_args): raise ValueError('MISSING_OR_UNCERTAIN')
            with self.assertRaises(subprocess.TimeoutExpired): setup.launch(provision_run=launch, instance_reader=missing)
            with self.assertRaisesRegex(ValueError, 'HOST_LAUNCH_UNCERTAIN_RECONCILE_ONLY'):
                setup.launch(provision_run=launch, instance_reader=missing)
            self.assertEqual(attempts, ['backend'])

    def test_address_phase_waits_read_only_for_hosts_before_allocating(self):
        with tempfile.TemporaryDirectory() as d:
            module, setup, aws, root, _, _ = self.fixture(d)
            setup.prepare()
            config = setup.plan()['config']
            for role in ['backend', 'pepper']:
                directory = root/(role+'-launch'); directory.mkdir(mode=0o700)
                module.write_private(directory/(role+'-instance.json'), {'Instances': [{'InstanceId': 'i-0123456789abcdef0'}]})
            original = aws.request; observed = {}
            def request(profile, service, operation, inputs):
                if operation == 'describe-instances':
                    observed[profile] = observed.get(profile, 0) + 1
                    return {'Reservations': [{'OwnerId': aws.accounts[profile], 'Instances': [{'InstanceId': inputs['InstanceIds'][0],
                        'State': {'Name': 'pending' if observed[profile] == 1 else 'running'}}]}]}
                return original(profile, service, operation, inputs)
            aws.request = request; setup.polls = 2
            setup.wait_hosts_running(config)
            self.assertEqual(list(observed.values()), [2, 2])
            self.assertFalse(any(c[2] in {'allocate-address', 'associate-address'} for c in aws.calls))


if __name__ == '__main__': unittest.main()
