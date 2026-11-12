"""Offline security-boundary invariants for the operator IAM/S3 template."""
import json
from pathlib import Path
import unittest

TEMPLATE = Path(__file__).with_name('identity-storage.json')
NONE = object()


def render(value, backend):
    if isinstance(value, list):
        return [item for raw in value if (item := render(raw, backend)) is not NONE]
    if isinstance(value, dict):
        if set(value) == {'Fn::If'}:
            condition, yes, no = value['Fn::If']
            if condition != 'IsBackend': raise AssertionError('unknown condition')
            return render(yes if backend else no, backend)
        if value == {'Ref': 'AWS::NoValue'}: return NONE
        return {key: render(raw, backend) for key, raw in value.items()}
    return value


class IdentityStorageTests(unittest.TestCase):
    def setUp(self):
        self.t = json.loads(TEMPLATE.read_text())
        self.resources = self.t['Resources']

    def statements(self, backend):
        return render(self.resources['HostIdentityRole']['Properties']['Policies'][0]['PolicyDocument']['Statement'], backend)

    def test_backend_backup_access_is_prefix_scoped_and_cannot_sign(self):
        statements = self.statements(True)
        allow = {s['Sid']: s for s in statements if s['Effect'] == 'Allow'}
        self.assertEqual(set(allow), {'LocateOwnBackupBucket', 'ListOnlyRepositoryPrefix', 'InspectOwnMultipartUploads', 'MaintainOwnRepositoryObjects'})
        objects = allow['MaintainOwnRepositoryObjects']
        self.assertEqual(objects['Resource'], {'Fn::Sub': '${BackupBucket.Arn}/kamui-sepolia/*'})
        self.assertEqual(set(objects['Action']), {'s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'})
        self.assertEqual(allow['ListOnlyRepositoryPrefix']['Condition'], {'StringLike': {'s3:prefix': ['kamui-sepolia', 'kamui-sepolia/*']}})
        self.assertIn({'Sid': 'NoKmsOnBackend', 'Effect': 'Deny', 'Action': 'kms:*', 'Resource': '*'}, statements)
        self.assertFalse(any('iam:PassRole' in str(s) for s in statements))

    def test_pepper_mac_allowlist_and_other_key_and_operation_denials(self):
        statements = {s['Sid']: s for s in self.statements(False)}
        self.assertEqual(set(statements['UseExistingPepperMacKey']['Action']), {'kms:GenerateMac', 'kms:VerifyMac', 'kms:DescribeKey'})
        self.assertEqual(statements['UseExistingPepperMacKey']['Resource'], {'Ref': 'ExistingPepperKeyArn'})
        self.assertEqual(statements['NoOtherKmsResource']['Action'], 'kms:*')
        self.assertEqual(statements['NoOtherKmsResource']['NotResource'], {'Ref': 'ExistingPepperKeyArn'})
        self.assertEqual(statements['NoOtherKmsResource']['Effect'], 'Deny')
        self.assertEqual(statements['NoOtherOperationOnPepperKey']['Effect'], 'Deny')
        self.assertEqual(set(statements['NoOtherOperationOnPepperKey']['NotAction']), {'kms:GenerateMac', 'kms:VerifyMac', 'kms:DescribeKey'})
        self.assertEqual(statements['NoOtherOperationOnPepperKey']['Resource'], {'Ref': 'ExistingPepperKeyArn'})
        self.assertFalse(any(s.get('Effect') == 'Allow' and 's3:' in str(s) for s in statements.values()))

    def test_ec2_only_trust_and_no_host_iam_or_role_chaining(self):
        role = self.resources['HostIdentityRole']['Properties']
        trust = role['AssumeRolePolicyDocument']['Statement']
        self.assertEqual(trust, [{'Effect': 'Allow', 'Principal': {'Service': 'ec2.amazonaws.com'}, 'Action': 'sts:AssumeRole'}])
        self.assertEqual(role['ManagedPolicyArns'], [{'Fn::Sub': 'arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore'}])
        for backend in [True, False]:
            deny = next(s for s in self.statements(backend) if s['Sid'] == 'NoIamOrRoleChaining')
            self.assertEqual(deny['Effect'], 'Deny')
            self.assertIn('iam:*', deny['Action']); self.assertIn('sts:AssumeRole', deny['Action'])
            self.assertEqual(deny['Resource'], '*')
        self.assertEqual(self.resources['InstanceProfile']['Properties']['Roles'], [{'Ref': 'HostIdentityRole'}])

    def test_backup_controls_and_retention_do_not_delete_wal(self):
        bucket = self.resources['BackupBucket']
        self.assertEqual(bucket['Condition'], 'IsBackend')
        for key in ['DeletionPolicy', 'UpdateReplacePolicy']: self.assertEqual(bucket[key], 'Retain')
        props = bucket['Properties']
        self.assertTrue(all(props['PublicAccessBlockConfiguration'].values()))
        self.assertEqual(props['OwnershipControls'], {'Rules': [{'ObjectOwnership': 'BucketOwnerEnforced'}]})
        self.assertEqual(props['BucketEncryption']['ServerSideEncryptionConfiguration'][0]['ServerSideEncryptionByDefault']['SSEAlgorithm'], 'AES256')
        self.assertNotIn('LifecycleConfiguration', props)
        self.assertNotIn('VersioningConfiguration', props)
        policy = self.resources['BackupBucketPolicy']
        self.assertEqual(policy['DeletionPolicy'], 'Retain')
        statement = policy['Properties']['PolicyDocument']['Statement'][0]
        self.assertEqual(statement['Effect'], 'Deny'); self.assertEqual(statement['Principal'], '*')
        self.assertEqual(statement['Action'], 's3:*')
        self.assertEqual(statement['Condition'], {'Bool': {'aws:SecureTransport': 'false'}})

    def test_no_existing_key_mutation_and_parent_output_contract(self):
        self.assertFalse(any(v['Type'].startswith('AWS::KMS::') for v in self.resources.values()))
        self.assertEqual(self.t['Parameters']['HostRole']['AllowedValues'], ['backend', 'pepper'])
        self.assertEqual(set(self.t['Outputs']), {'InstanceProfileName', 'HostRoleArn', 'BackupBucketName', 'BackupRepositoryPrefix'})
        self.assertEqual(self.t['Outputs']['BackupBucketName']['Condition'], 'IsBackend')
        self.assertTrue({'BackendBucketRequired', 'PepperKeyRequired', 'SepoliaRegion'} <= self.t['Rules'].keys())
        self.assertFalse(self.t['Parameters'].keys() & self.resources.keys())


if __name__ == '__main__': unittest.main()
