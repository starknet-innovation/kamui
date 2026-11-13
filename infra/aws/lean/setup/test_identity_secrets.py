"""The successor identity template and its guarded change-set update. All AWS calls are faked."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

import test_integration as integration
from test_identity_storage import render

HERE = Path(__file__).resolve().parent
ORIGINAL = json.loads((HERE/'identity-storage.json').read_text())
SUCCESSOR = json.loads((HERE/'identity-secrets.json').read_text())
KEY = {'Fn::GetAtt': ['RuntimeSecretsKey', 'Arn']}
VIA = {'Fn::Sub': 'secretsmanager.${AWS::Region}.amazonaws.com'}


def statements(template, backend):
    raw = template['Resources']['HostIdentityRole']['Properties']['Policies'][0]['PolicyDocument']['Statement']
    return {s['Sid']: s for s in render(raw, backend)}


class SuccessorTemplateTest(unittest.TestCase):
    def test_successor_keeps_every_original_resource_and_statement_except_the_two_narrowed_denies(self):
        for name, resource in ORIGINAL['Resources'].items():
            if name == 'HostIdentityRole': continue
            self.assertEqual(SUCCESSOR['Resources'][name], resource, name)
        for key in ['Parameters', 'Conditions', 'Rules']:
            self.assertEqual(SUCCESSOR.get(key), ORIGINAL.get(key), key)
        for backend in [True, False]:
            before, after = statements(ORIGINAL, backend), statements(SUCCESSOR, backend)
            for sid, statement in before.items():
                if sid in {'NoKmsOnBackend', 'NoOtherKmsResource'}: continue
                self.assertEqual(after[sid], statement, sid)
        role_before = {k: v for k, v in ORIGINAL['Resources']['HostIdentityRole'].items() if k != 'Properties'}
        role_after = {k: v for k, v in SUCCESSOR['Resources']['HostIdentityRole'].items() if k != 'Properties'}
        self.assertEqual(role_before, role_after)
        for key, value in ORIGINAL['Resources']['HostIdentityRole']['Properties'].items():
            if key != 'Policies': self.assertEqual(SUCCESSOR['Resources']['HostIdentityRole']['Properties'][key], value, key)

    def test_kms_denies_open_only_the_runtime_key_and_only_for_decrypt_through_secrets_manager(self):
        backend, pepper = statements(SUCCESSOR, True), statements(SUCCESSOR, False)
        self.assertEqual(backend['NoKmsOnBackend'], {'Sid': 'NoKmsOnBackend', 'Effect': 'Deny', 'Action': 'kms:*', 'NotResource': KEY})
        self.assertEqual(pepper['NoOtherKmsResource']['NotResource'], [{'Ref': 'ExistingPepperKeyArn'}, KEY])
        self.assertEqual(pepper['NoOtherOperationOnPepperKey'], statements(ORIGINAL, False)['NoOtherOperationOnPepperKey'])
        for role in [backend, pepper]:
            self.assertEqual(role['OnlyDecryptOnRuntimeSecretsKey'], {'Sid': 'OnlyDecryptOnRuntimeSecretsKey', 'Effect': 'Deny', 'NotAction': 'kms:Decrypt', 'Resource': KEY})
            self.assertEqual(role['RuntimeSecretsKeyOnlyThroughSecretsManager']['Condition'], {'StringNotEquals': {'kms:ViaService': VIA}})
            self.assertEqual(role['DecryptRuntimeSecretsThroughSecretsManager']['Condition'], {'StringEquals': {'kms:ViaService': VIA}})
            self.assertEqual(role['DecryptRuntimeSecretsThroughSecretsManager']['Action'], 'kms:Decrypt')
        self.assertEqual(backend['ReadOwnRuntimeSecrets']['Resource'], [{'Ref': 'RuntimeSecret'}, {'Ref': 'RelayerSecret'}])
        self.assertEqual(pepper['ReadOwnRuntimeSecrets']['Resource'], [{'Ref': 'RuntimeSecret'}])
        # No statement anywhere grants a secret write, a KMS write or a broader read.
        for role in [backend, pepper]:
            for statement in role.values():
                if statement['Effect'] != 'Allow': continue
                actions = statement.get('Action'); actions = [actions] if isinstance(actions, str) else actions
                self.assertFalse(any(a.startswith('secretsmanager:') and a != 'secretsmanager:GetSecretValue' for a in actions))
                self.assertFalse(any(a.startswith('kms:') and a not in {'kms:Decrypt', 'kms:GenerateMac', 'kms:VerifyMac', 'kms:DescribeKey'} for a in actions))

    def test_only_the_host_role_may_read_secret_values_and_the_key_names_no_principal(self):
        resources = SUCCESSOR['Resources']
        for name in ['RuntimeSecretPolicy', 'RelayerSecretPolicy']:
            statement = resources[name]['Properties']['ResourcePolicy']['Statement']
            self.assertEqual(statement, [{'Sid': 'OnlyThisHostReadsTheValue', 'Effect': 'Deny', 'Principal': '*',
                'Action': 'secretsmanager:GetSecretValue', 'Resource': '*',
                'Condition': {'StringNotEquals': {'aws:PrincipalArn': {'Fn::GetAtt': ['HostIdentityRole', 'Arn']}}}}])
            self.assertTrue(resources[name]['Properties']['BlockPublicPolicy'])
        key_statements = resources['RuntimeSecretsKey']['Properties']['KeyPolicy']['Statement']
        self.assertEqual([s['Principal'] for s in key_statements], [{'AWS': {'Fn::Sub': 'arn:${AWS::Partition}:iam::${AWS::AccountId}:root'}}])
        for name in ['RuntimeSecretsKey', 'RuntimeSecret', 'RelayerSecret']:
            self.assertEqual((resources[name]['DeletionPolicy'], resources[name]['UpdateReplacePolicy']), ('Retain', 'Retain'))
        self.assertEqual(resources['RelayerSecret']['Condition'], 'IsBackend')
        self.assertEqual(resources['RelayerSecretPolicy']['Condition'], 'IsBackend')
        self.assertNotIn('SecretString', resources['RelayerSecret']['Properties'])


class ChangeSetFake:
    """Adds CloudFormation change sets to the integration fake: a diff of logical ids, then apply."""
    def __init__(self, aws, module, extra=None):
        self.aws, self.module, self.extra = aws, module, extra
        self.original = aws.request; self.sets = {}; self.executed = 0
        aws.request = self.request

    def request(self, profile, service, operation, inputs):
        if service != 'cloudformation' or operation not in {'create-change-set', 'describe-change-set', 'execute-change-set'}:
            return self.original(profile, service, operation, inputs)
        self.aws.calls.append((profile, service, operation, copy.deepcopy(inputs)))
        key = (profile, inputs['StackName'], inputs['ChangeSetName'])
        if operation == 'create-change-set':
            new = json.loads(inputs['TemplateBody']); old = self.aws.templates[(profile, inputs['StackName'])]
            role = {p['ParameterKey']: p['ParameterValue'] for p in inputs['Parameters']}['HostRole']
            changes = [{'Type': 'Resource', 'ResourceChange': {'Action': 'Add', 'LogicalResourceId': name,
                        'ResourceType': value['Type']}}
                       for name, value in new['Resources'].items()
                       if name not in old['Resources'] and not (value.get('Condition') == 'IsBackend' and role != 'backend')]
            changes.append({'Type': 'Resource', 'ResourceChange': {'Action': 'Modify', 'LogicalResourceId': 'HostIdentityRole',
                            'ResourceType': 'AWS::IAM::Role', 'Replacement': 'False'}})
            if self.extra: changes.append(self.extra)
            self.sets[key] = {'template': new, 'changes': changes, 'role': role}
            return {'Id': 'change-set-fixture'}
        if operation == 'describe-change-set':
            return {'Status': 'CREATE_COMPLETE', 'ExecutionStatus': 'AVAILABLE', 'Changes': self.sets[key]['changes']}
        entry = self.sets[key]; self.executed += 1
        stack = self.aws.stacks[(profile, inputs['StackName'])]
        self.aws.templates[(profile, inputs['StackName'])] = entry['template']
        stack['StackStatus'] = 'UPDATE_COMPLETE'
        account = '000000000001' if entry['role'] == 'backend' else '000000000002'
        added = {'RuntimeSecretArn': f'arn:aws:secretsmanager:eu-west-1:{account}:secret:kamui-sepolia/{entry["role"]}/runtime-AbCdEf',
                 'RuntimeSecretsKeyArn': f'arn:aws:kms:eu-west-1:{account}:key/22222222-2222-2222-2222-222222222222'}
        if entry['role'] == 'backend':
            added['RelayerSecretArn'] = f'arn:aws:secretsmanager:eu-west-1:{account}:secret:kamui-sepolia/backend/relayer-private-key-GhIjKl'
        stack['Outputs'] = stack.get('Outputs', []) + [{'OutputKey': k, 'OutputValue': v} for k, v in added.items()]
        return {}


class IdentitySecretsUpdateTest(unittest.TestCase):
    def fixture(self, directory, extra=None):
        module, setup, aws, root, _, _ = integration.ResourceIntegrationTest.fixture(self, directory)
        setup.prepare(); setup.network(); setup.identity(); setup.export()
        return module, setup, aws, root, ChangeSetFake(aws, module, extra)

    def writes(self, aws, module):
        return [(s, o) for _, s, o, _ in aws.calls if (s, o) in module.WRITES]

    def test_first_run_reviews_and_changes_nothing_then_execute_applies_once(self):
        with tempfile.TemporaryDirectory() as d:
            module, setup, aws, root, fake = self.fixture(d)
            before = len(self.writes(aws, module))
            setup.identity_secrets()
            self.assertEqual(fake.executed, 0)
            self.assertEqual(self.writes(aws, module)[before:], [('cloudformation', 'create-change-set')]*2)
            self.assertFalse((root/'resources-setup/backend-identity-secrets-result.json').exists())
            setup.identity_secrets(execute=True)
            self.assertEqual(fake.executed, 2)
            self.assertEqual(self.writes(aws, module)[before:], [('cloudformation', 'create-change-set')]*2 + [('cloudformation', 'execute-change-set')]*2)
            backend = json.loads((root/'resources-setup/backend-identity-secrets-result.json').read_text())
            pepper = json.loads((root/'resources-setup/pepper-identity-secrets-result.json').read_text())
            self.assertIn('RelayerSecretArn', backend); self.assertNotIn('RelayerSecretArn', pepper)
            # Rerunning after it applied neither creates nor executes anything again.
            count = len(self.writes(aws, module))
            setup.identity_secrets(execute=True)
            self.assertEqual(len(self.writes(aws, module)), count)
            # Earlier steps still verify the stacks they created, now in their updated state.
            setup.export()

    def test_unexpected_change_or_replacement_is_never_executed(self):
        for extra, error in [
            ({'Type': 'Resource', 'ResourceChange': {'Action': 'Remove', 'LogicalResourceId': 'BackupBucket', 'ResourceType': 'AWS::S3::Bucket'}}, 'CHANGE_SET_SCOPE_UNEXPECTED_NOT_EXECUTED'),
            ({'Type': 'Resource', 'ResourceChange': {'Action': 'Modify', 'LogicalResourceId': 'InstanceProfile', 'ResourceType': 'AWS::IAM::InstanceProfile', 'Replacement': 'True'}}, 'CHANGE_SET_SCOPE_UNEXPECTED_NOT_EXECUTED'),
        ]:
            with self.subTest(extra=extra['ResourceChange']['LogicalResourceId']), tempfile.TemporaryDirectory() as d:
                module, setup, aws, _, fake = self.fixture(d, extra)
                with self.assertRaisesRegex(ValueError, error): setup.identity_secrets(execute=True)
                self.assertEqual(fake.executed, 0)
                self.assertNotIn(('cloudformation', 'execute-change-set'), self.writes(aws, module))

    def test_drifted_stack_is_refused_before_any_change_set(self):
        with tempfile.TemporaryDirectory() as d:
            module, setup, aws, _, fake = self.fixture(d)
            for key in list(aws.templates):
                if 'identity' in key[1]: aws.templates[key] = {**aws.templates[key], 'Description': 'changed outside'}
            with self.assertRaisesRegex(ValueError, 'DEPLOYED_TEMPLATE_MISMATCH'): setup.identity_secrets(execute=True)
            self.assertNotIn(('cloudformation', 'create-change-set'), self.writes(aws, module))

    def test_change_set_differing_from_the_reviewed_one_is_not_executed(self):
        with tempfile.TemporaryDirectory() as d:
            module, setup, aws, _, fake = self.fixture(d)
            setup.identity_secrets()
            for entry in fake.sets.values():
                entry['changes'][-1]['ResourceChange']['ResourceType'] = 'AWS::IAM::Policy'
            with self.assertRaisesRegex(ValueError, 'CHANGE_SET_CHANGED_SINCE_REVIEW'): setup.identity_secrets(execute=True)
            self.assertEqual(fake.executed, 0)


if __name__ == '__main__':
    unittest.main()
