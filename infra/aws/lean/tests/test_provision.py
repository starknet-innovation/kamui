import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

SPEC = importlib.util.spec_from_file_location('provision', Path(__file__).resolve().parents[1]/'scripts/provision.py')
provision = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(provision)


class ProvisionTest(unittest.TestCase):
    def values(self, path):
        return {'KAMUI_INFRA_REVIEWED': 'yes', 'KAMUI_ROLE': 'backend', 'AWS_PROFILE': 'fixture',
                'EXPECTED_ACCOUNT': '123456789012', 'AMI_ID': 'ami-0123456789abcdef0',
                'SUBNET_ID': 'subnet-0123456789abcdef0', 'SECURITY_GROUP_ID': 'sg-0123456789abcdef0',
                'INSTANCE_PROFILE_NAME': 'fixture-role', 'ROOT_DEVICE_NAME': '/dev/sda1',
                'OPERATOR_PRIVATE_DIRECTORY': str(path.resolve())}

    def fake(self, account, calls, fail=False):
        def invoke(args, **kwargs):
            calls.append(args)
            self.assertEqual(kwargs['env']['AWS_MAX_ATTEMPTS'], '1')
            if args[1:3] == ['sts', 'get-caller-identity']:
                kwargs['stdout'].write(json.dumps({'Account': account}).encode())
                return SimpleNamespace(returncode=0)
            self.assertEqual(args[1:3], ['ec2', 'run-instances'])
            path=Path(args[-1].removeprefix('file://'))
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            payload=json.loads(path.read_text())
            self.assertEqual(payload['MaxCount'], 1)
            self.assertEqual(payload['MetadataOptions']['HttpTokens'], 'required')
            self.assertEqual(payload['CreditSpecification']['CpuCredits'], 'standard')
            self.assertTrue(payload['BlockDeviceMappings'][0]['Ebs']['Encrypted'])
            self.assertFalse(payload['BlockDeviceMappings'][0]['Ebs']['DeleteOnTermination'])
            self.assertNotIn('ami-', ' '.join(args))
            if fail: raise TimeoutError('PRIVATE_DIAGNOSTIC')
            kwargs['stdout'].write(b'{"Instances":[{"InstanceId":"PRIVATE_INSTANCE"}]}')
            return SimpleNamespace(returncode=0)
        return invoke

    def test_one_launch_has_durable_private_intent_and_prevents_second_submission(self):
        with tempfile.TemporaryDirectory() as path:
            calls=[]; values=self.values(Path(path))
            provision.run(values, self.fake(values['EXPECTED_ACCOUNT'], calls))
            self.assertEqual(len(calls), 2)
            self.assertTrue((Path(path)/'backend-launch-intent.json').exists())
            with self.assertRaisesRegex(ValueError, 'LAUNCH_INTENT_EXISTS_RECONCILE_ONLY'):
                provision.run(values, self.fake(values['EXPECTED_ACCOUNT'], calls))
            self.assertEqual(len(calls), 2)

    def test_wrong_account_never_creates_intent_or_launches(self):
        with tempfile.TemporaryDirectory() as path:
            calls=[]; values=self.values(Path(path))
            with self.assertRaisesRegex(ValueError, 'EXPECTED_ACCOUNT_MISMATCH'):
                provision.run(values, self.fake('000000000000', calls))
            self.assertEqual(len(calls), 1)
            self.assertFalse((Path(path)/'backend-launch-intent.json').exists())

    def test_uncertain_launch_keeps_intent_and_does_not_retry(self):
        with tempfile.TemporaryDirectory() as path:
            calls=[]; values=self.values(Path(path))
            with self.assertRaises(TimeoutError):
                provision.run(values, self.fake(values['EXPECTED_ACCOUNT'], calls, fail=True))
            self.assertEqual(len(calls), 2)
            self.assertTrue((Path(path)/'backend-launch-intent.json').exists())
            with self.assertRaisesRegex(ValueError, 'LAUNCH_INTENT_EXISTS_RECONCILE_ONLY'):
                provision.run(values, self.fake(values['EXPECTED_ACCOUNT'], calls))
            self.assertEqual(len(calls), 2)

    def test_review_and_private_directory_required(self):
        with tempfile.TemporaryDirectory() as path:
            values=self.values(Path(path)); values['KAMUI_INFRA_REVIEWED']='no'
            with self.assertRaisesRegex(ValueError, 'INFRA_REVIEW_REQUIRED'):provision.validate(values)
            values['KAMUI_INFRA_REVIEWED']='yes'; Path(path).chmod(0o755)
            with self.assertRaisesRegex(ValueError, 'PRIVATE_DIRECTORY_REQUIRED'):provision.validate(values)


if __name__ == '__main__': unittest.main()
