"""Fake-AWS operator sequence integration. Never contacts AWS or reads real local setup."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


def load_runner():
    spec = importlib.util.spec_from_file_location('kamui_resource_setup_integration', HERE/'setup_resources.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeAws:
    """Stateful CloudFormation plus the selected-resource read contract."""
    def __init__(self, module):
        self.module = module
        self.calls = []
        self.stacks = {}
        self.templates = {}
        self.accounts = {'kamui-backend-test': '000000000001', 'kamui-pepper-test': '000000000002'}

    def request(self, profile, service, operation, inputs):
        self.calls.append((profile, service, operation, copy.deepcopy(inputs)))
        role = 'backend' if profile == 'kamui-backend-test' else 'pepper'
        account = self.accounts[profile]
        if (service, operation) == ('sts', 'get-caller-identity'):
            return {'Account': account, 'Arn': f'arn:aws:iam::{account}:user/fixture'}
        if (service, operation) == ('ssm', 'get-parameter'):
            return {'Parameter': {'Name': inputs['Name'], 'Value': 'ami-0123456789abcdef0', 'Type': 'String', 'Version': 1}}
        if (service, operation) == ('ec2', 'describe-availability-zones'):
            return {'AvailabilityZones': [{'ZoneName': 'eu-west-1a', 'State': 'available', 'RegionName': 'eu-west-1', 'OptInStatus': 'opt-in-not-required'}]}
        if (service, operation) == ('ec2', 'describe-images'):
            return {'Images': [{'ImageId': 'ami-0123456789abcdef0', 'OwnerId': '000000000003', 'ImageOwnerAlias': 'amazon',
                                'Architecture': 'x86_64', 'State': 'available', 'RootDeviceType': 'ebs',
                                'RootDeviceName': '/dev/xvda', 'VirtualizationType': 'hvm', 'Name': 'al2023-ami-fixture-kernel-x86_64', 'Public': True}]}
        if (service, operation) == ('kms', 'describe-key'):
            return {'KeyMetadata': {'Arn': inputs['KeyId'], 'KeySpec': 'HMAC_256', 'KeyUsage': 'GENERATE_VERIFY_MAC',
                                    'Origin': 'AWS_KMS', 'KeyManager': 'CUSTOMER', 'KeyState': 'Enabled', 'Enabled': True}}
        if (service, operation) == ('kms', 'get-key-policy'):
            return {'Policy': json.dumps({'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow',
                'Principal': {'AWS': f'arn:aws:iam::{account}:root'}, 'Action': 'kms:*', 'Resource': '*'}]})}
        if (service, operation) == ('cloudformation', 'validate-template'):
            return {'Parameters': [{'ParameterKey': key} for key in json.loads(inputs['TemplateBody'])['Parameters']]}
        if (service, operation) == ('cloudformation', 'describe-stacks'):
            stack = self.stacks.get((profile, inputs['StackName']))
            if stack is None:
                raise self.module.AwsError('STACK_NOT_FOUND')
            return {'Stacks': [copy.deepcopy(stack)]}
        if (service, operation) == ('cloudformation', 'create-stack'):
            template = json.loads(inputs['TemplateBody'])
            parameters = {item['ParameterKey']: item['ParameterValue'] for item in inputs.get('Parameters', [])}
            if 'SubnetId' in template.get('Outputs', {}):
                values = {'VpcId': 'vpc-0123456789abcdef0', 'SubnetId': 'subnet-0123456789abcdef0',
                          'SecurityGroupId': 'sg-0123456789abcdef0', 'AvailabilityZone': parameters.get('AvailabilityZone', 'eu-west-1a')}
            else:
                values = {'InstanceProfileName': f'KamuiSepolia{role.title()}Host',
                          'HostRoleArn': f'arn:aws:iam::{account}:role/kamui/sepolia/{role}',
                          'BackupBucketName': parameters.get('BackupBucketName', '') if role == 'backend' else '',
                          'BackupRepositoryPrefix': 'kamui-sepolia' if role == 'backend' else ''}
            stack = {'StackName': inputs['StackName'], 'StackId': f'arn:aws:cloudformation:eu-west-1:{account}:stack/{inputs["StackName"]}/fixture',
                     'StackStatus': 'CREATE_COMPLETE', 'Parameters': inputs.get('Parameters', []), 'Tags': inputs.get('Tags', []),
                     'Outputs': [{'OutputKey': key, 'OutputValue': value} for key, value in values.items()]}
            self.stacks[(profile, inputs['StackName'])] = stack
            self.templates[(profile, inputs['StackName'])] = template
            return {'StackId': stack['StackId']}
        if (service, operation) == ('cloudformation', 'get-template'):
            return {'TemplateBody': copy.deepcopy(self.templates[(profile, inputs['StackName'])])}
        if (service, operation) == ('ec2', 'describe-subnets'):
            return {'Subnets': [{'SubnetId': inputs['SubnetIds'][0], 'State': 'available', 'VpcId': 'vpc-0123456789abcdef0', 'AvailabilityZone': 'eu-west-1a'}]}
        if (service, operation) == ('ec2', 'describe-security-groups'):
            return {'SecurityGroups': [{'GroupId': inputs['GroupIds'][0], 'VpcId': 'vpc-0123456789abcdef0', 'IpPermissions':
                [{'IpProtocol': 'tcp', 'FromPort': p, 'ToPort': p, 'IpRanges': [{'CidrIp': '0.0.0.0/0'}]} for p in [80,443]]}]}
        if (service, operation) == ('ec2', 'describe-route-tables'):
            return {'RouteTables': [{'Routes': [{'DestinationCidrBlock': '0.0.0.0/0', 'GatewayId': 'igw-0123456789abcdef0', 'State': 'active'}]}]}
        if (service, operation) == ('iam', 'get-instance-profile'):
            return {'InstanceProfile': {'Roles': [{'Arn': f'arn:aws:iam::{account}:role/kamui/sepolia/{role}'}]}}
        if (service, operation) == ('s3api', 'head-bucket'):
            return {'BucketRegion': 'eu-west-1'}
        if (service, operation) == ('s3api', 'get-public-access-block'):
            return {'PublicAccessBlockConfiguration': dict.fromkeys(['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets'], True)}
        if (service, operation) == ('s3api', 'get-bucket-encryption'):
            return {'ServerSideEncryptionConfiguration': {'Rules': [{'ApplyServerSideEncryptionByDefault': {'SSEAlgorithm': 'AES256'}}]}}
        raise AssertionError(f'unexpected fake AWS operation {service}/{operation}')


class ResourceIntegrationTest(unittest.TestCase):
    def fixture(self, directory):
        module = load_runner()
        root = Path(directory).resolve()/'hosting'; root.mkdir(mode=0o700)
        record = Path(directory)/'retained-backend.json'
        record.write_text(json.dumps({'version': 1, 'region': 'eu-west-1', 'account': '000000000001'})); record.chmod(0o600)
        env = Path(directory)/'pepper.env.local'
        marker = Path(directory)/'MUST_NOT_BE_CREATED'
        env.write_text(f'UNUSED_SECRET=$(touch {marker})\nKMS_KEY_ID=arn:aws:kms:eu-west-1:000000000002:key/11111111-1111-1111-1111-111111111111\n')
        env.chmod(0o600)
        initial = json.loads((HERE.parent/'readiness/private-input.example.json').read_text())
        path = root/'aws-input.json'; path.write_text(json.dumps(initial)); path.chmod(0o600)
        aws = FakeAws(module)
        setup = module.Setup(root, aws, record, env, sleep=lambda _: None, polls=1)
        return module, setup, aws, root, marker, initial

    def test_ordered_fake_resources_export_to_existing_inspector_and_reopen_without_new_creates(self):
        with tempfile.TemporaryDirectory() as directory:
            module, setup, aws, root, marker, initial = self.fixture(directory)
            setup.prepare(); setup.network(); setup.identity(); setup.export()
            self.assertFalse(marker.exists(), 'pepper configuration must never be shell-evaluated')
            result = json.loads((root/'aws-input.json').read_text())
            self.assertEqual(result['backend']['expected_account'], '000000000001')
            self.assertEqual(result['pepper']['expected_account'], '000000000002')
            self.assertNotEqual(result['backend']['expected_account'], result['pepper']['expected_account'])
            self.assertTrue(module.module('inspect_aws').inspect(result, aws)['all_observed_checks_passed'])
            self.assertEqual((root/'aws-input.json').stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads((root/'resources-setup/aws-input-before.json').read_text()), initial)
            mutations = [(s, o) for _, s, o, _ in aws.calls if (s,o) in module.WRITES]
            self.assertEqual(mutations, [('cloudformation','create-stack')]*4)
            # New process style construction must use saved pins/intents, not create a fifth stack.
            reopened = module.Setup(root, aws, setup.backend_record, setup.pepper_env, sleep=lambda _: None, polls=1)
            reopened.prepare(); reopened.network(); reopened.identity(); reopened.export()
            self.assertEqual([(s,o) for _,s,o,_ in aws.calls if (s,o) in module.WRITES], mutations)
            self.assertFalse(any(s == 'ec2' and o in {'run-instances','allocate-address'} for _,s,o,_ in aws.calls))

    def test_lost_create_response_reopens_and_reconciles_same_stack_without_resubmitting(self):
        with tempfile.TemporaryDirectory() as directory:
            module, setup, aws, root, _, _ = self.fixture(directory)
            setup.prepare()
            original = aws.request
            lost = False
            def request(profile, service, operation, inputs):
                nonlocal lost
                answer = original(profile, service, operation, inputs)
                if operation == 'create-stack' and not lost:
                    lost = True
                    raise module.AwsError('AWS_REQUEST_UNCERTAIN', uncertain=True)
                return answer
            aws.request = request
            with self.assertRaises(module.AwsError): setup.network()
            self.assertEqual(len(aws.stacks), 1)
            reopened = module.Setup(root, aws, setup.backend_record, setup.pepper_env, sleep=lambda _: None, polls=1)
            reopened.network(); reopened.identity(); reopened.export()
            creates = [c for c in aws.calls if c[1:3] == ('cloudformation','create-stack')]
            self.assertEqual(len(creates), 4)
            self.assertEqual(len({(c[0],c[3]['StackName']) for c in creates}), 4)

    def test_changed_profile_account_before_second_phase_blocks_all_mutations(self):
        with tempfile.TemporaryDirectory() as directory:
            module, setup, aws, _, _, _ = self.fixture(directory)
            setup.prepare()
            aws.accounts['kamui-pepper-test'] = '000000000004'
            with self.assertRaisesRegex(ValueError, 'EXPECTED_ACCOUNT_MISMATCH'): setup.network()
            self.assertFalse(any((s,o) in module.WRITES for _,s,o,_ in aws.calls))

    def test_concurrent_private_input_edit_is_preserved_without_export_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            _, setup, _, root, _, _ = self.fixture(directory)
            setup.prepare(); setup.network(); setup.identity()
            changed = json.loads((root/'aws-input.json').read_text())
            changed['backend']['aws_profile'] = 'operator-edited-profile'
            content = json.dumps(changed)
            (root/'aws-input.json').write_text(content)
            with self.assertRaisesRegex(ValueError, 'PRIVATE_INPUT_CHANGED_REFUSE_OVERWRITE'): setup.export()
            self.assertEqual((root/'aws-input.json').read_text(), content)


if __name__ == '__main__': unittest.main()
