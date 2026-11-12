"""No AWS/network calls. Public IP literals are synthetic response fixtures only."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('addresses', HERE/'addresses.py')
addresses = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(addresses)


def private(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.write_text(json.dumps(value)); path.chmod(0o600)


class FakeAws:
    def __init__(self, config):
        self.config = config; self.calls = []; self.addresses = []
        self.fail_allocate = None; self.fail_associate = None; self.wrong_account = None
        self.instances = {}
        for index, role in enumerate(['backend', 'pepper'], 1):
            values = config[role]
            instance_id = 'i-'+str(index).zfill(8)
            eni = 'eni-'+str(index).zfill(8)
            self.instances[role] = {'InstanceId': instance_id, 'ImageId': values['ami_id'], 'SubnetId': values['subnet_id'],
                'State': {'Name': 'running'}, 'Tags': [{'Key': k, 'Value': v} for k,v in {'Project':'kamui','Network':'sepolia','Role':role}.items()],
                'SecurityGroups': [{'GroupId': values['security_group_id']}],
                'NetworkInterfaces': [{'NetworkInterfaceId': eni, 'PrivateIpAddress': '10.68.0.'+str(index+10), 'SubnetId': values['subnet_id'],
                    'Attachment': {'DeviceIndex': 0, 'InstanceId': instance_id}, 'Groups': [{'GroupId': values['security_group_id']}]}]}

    def request(self, profile, service, operation, inputs):
        self.calls.append((profile, service, operation, copy.deepcopy(inputs)))
        role = 'backend' if profile == 'backend-profile' else 'pepper'
        if operation == 'get-caller-identity':
            return {'Account': 'wrong' if role == self.wrong_account else self.config[role]['expected_account']}
        if operation == 'describe-instances':
            return {'Reservations': [{'OwnerId': self.config[role]['expected_account'], 'Instances': [copy.deepcopy(self.instances[role])]}]}
        if operation == 'describe-addresses':
            matches = [copy.deepcopy(a) for a in self.addresses if a['_role'] == role]
            if 'AllocationIds' in inputs:
                matches = [a for a in matches if a['AllocationId'] in inputs['AllocationIds']]
            for f in inputs.get('Filters', []):
                if f['Name'] == 'instance-id':
                    matches = [a for a in matches if a.get('InstanceId') in f['Values']]
                elif f['Name'].startswith('tag:'):
                    key = f['Name'][4:]
                    matches = [a for a in matches if {t['Key']:t['Value'] for t in a.get('Tags',[])}.get(key) in f['Values']]
                else: raise AssertionError('unexpected filter')
            return {'Addresses': matches}
        if operation == 'allocate-address':
            index = len(self.addresses) + 1
            result = {'_role': role, 'AllocationId': 'eipalloc-'+str(index).zfill(8), 'Domain':'vpc',
                'PublicIp': '8.8.8.8' if role == 'backend' else '1.1.1.1', 'Tags': copy.deepcopy(inputs['TagSpecifications'][0]['Tags'])}
            if self.fail_allocate != 'before': self.addresses.append(result)
            if self.fail_allocate:
                self.fail_allocate = None
                raise RuntimeError('PRIVATE_AWS_FAILURE_SENTINEL')
            return {k:v for k,v in result.items() if k not in {'_role', 'Tags'}}
        if operation == 'associate-address':
            address = next(a for a in self.addresses if a['AllocationId'] == inputs['AllocationId'])
            if self.fail_associate != 'before':
                address.update(InstanceId=self.instances[role]['InstanceId'], NetworkInterfaceId=inputs['NetworkInterfaceId'],
                    PrivateIpAddress=inputs['PrivateIpAddress'], AssociationId='eipassoc-'+str(len(self.calls)).zfill(8))
            if self.fail_associate:
                self.fail_associate = None
                raise RuntimeError('PRIVATE_AWS_FAILURE_SENTINEL')
            return {'AssociationId': address['AssociationId']}
        raise AssertionError('unexpected AWS operation')

    def mutations(self, kind=None):
        return [c for c in self.calls if c[2] in {'allocate-address','associate-address'} and (kind is None or c[2] == kind)]


class AddressesTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve(); root.chmod(0o700)
        config = {'version':1, 'region':'eu-west-1'}
        private(root/'resources-setup'/'plan.json', {'runId':'a'*32})
        for index, role in enumerate(['backend','pepper'], 1):
            config[role] = {'aws_profile':role+'-profile','expected_account':str(index).zfill(12),
                'ami_id':'ami-'+str(index).zfill(8),'subnet_id':'subnet-'+str(index).zfill(8), 'security_group_id':'sg-'+str(index).zfill(8)}
            private(root/(role+'-launch')/(role+'-instance.json'), {'Instances':[{'InstanceId':'i-'+str(index).zfill(8)}]})
        return root, config, FakeAws(config)

    def test_assigns_two_exact_eips_and_rerun_only_verifies(self):
        root, config, aws = self.fixture()
        report = addresses.assign(root, config, aws)
        self.assertEqual(report['status'], 'addresses_verified')
        self.assertEqual(len(aws.mutations('allocate-address')), 2)
        self.assertEqual(len(aws.mutations('associate-address')), 2)
        self.assertEqual([c[2] for c in aws.calls[:2]], ['get-caller-identity']*2)
        for call in aws.mutations('allocate-address'):
            self.assertNotIn('ClientToken', call[3]); self.assertEqual(call[3]['Domain'], 'vpc')
        for call in aws.mutations('associate-address'):
            self.assertIs(call[3]['AllowReassociation'], False)
            self.assertIn('NetworkInterfaceId', call[3]); self.assertNotIn('InstanceId', call[3])
        count = len(aws.mutations()); addresses.assign(root, config, aws)
        self.assertEqual(len(aws.mutations()), count)
        for role in ['backend','pepper']:
            path = root/'resources-setup'/'addresses'/(role+'-verified.json')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            saved = json.loads(path.read_text())
            self.assertEqual(saved['InstanceId'], aws.instances[role]['InstanceId'])
            self.assertNotIn(saved['PublicIp'], json.dumps(report))

    def test_wrong_second_account_and_wrong_selected_host_block_all_mutations(self):
        for failure in ['account','group','subnet','state','eni']:
            root, config, aws = self.fixture()
            if failure == 'account': aws.wrong_account = 'pepper'
            elif failure == 'group': aws.instances['pepper']['SecurityGroups'].append({'GroupId':'sg-99999999'})
            elif failure == 'subnet': aws.instances['pepper']['SubnetId'] = 'subnet-99999999'
            elif failure == 'state': aws.instances['pepper']['State']['Name'] = 'terminated'
            else: aws.instances['pepper']['NetworkInterfaces'].append({})
            with self.assertRaises(ValueError): addresses.assign(root, config, aws)
            self.assertEqual(aws.mutations(), [])
            if failure == 'account': self.assertEqual([c[2] for c in aws.calls], ['get-caller-identity']*2)

    def test_allocation_uncertainty_never_allocates_again_and_can_reconcile_one_tag_match(self):
        for when in ['before','after']:
            root, config, aws = self.fixture(); aws.fail_allocate = when
            with self.assertRaisesRegex(ValueError, 'ADDRESS_REQUEST_UNCERTAIN_KEEP_PRIVATE_STATE'):
                addresses.assign(root, config, aws)
            self.assertEqual(len(aws.mutations('allocate-address')), 1)
            intent = root/'resources-setup'/'addresses'/'backend-allocate-intent.json'
            self.assertTrue(intent.exists())
            if when == 'before':
                with self.assertRaisesRegex(ValueError, 'ADDRESS_ALLOCATION_UNCERTAIN_RECONCILE_ONLY'):
                    addresses.assign(root, config, aws)
                self.assertEqual(len(aws.mutations('allocate-address')), 1)
            else:
                addresses.assign(root, config, aws)
                self.assertEqual(len([c for c in aws.mutations('allocate-address') if c[0]=='backend-profile']), 1)

    def test_association_uncertainty_never_resends_and_can_reconcile_success(self):
        for when in ['before','after']:
            root, config, aws = self.fixture(); aws.fail_associate = when
            with self.assertRaisesRegex(ValueError, 'ADDRESS_REQUEST_UNCERTAIN_KEEP_PRIVATE_STATE'):
                addresses.assign(root, config, aws)
            self.assertEqual(len(aws.mutations('associate-address')), 1)
            if when == 'before':
                with self.assertRaisesRegex(ValueError, 'ADDRESS_ASSOCIATION_UNCERTAIN_RECONCILE_ONLY'):
                    addresses.assign(root, config, aws)
                self.assertEqual(len(aws.mutations('associate-address')), 1)
            else:
                addresses.assign(root, config, aws)
                self.assertEqual(len([c for c in aws.mutations('associate-address') if c[0]=='backend-profile']), 1)

    def test_foreign_address_on_target_and_ambiguous_setup_tags_never_get_replaced(self):
        for failure in ['foreign','ambiguous']:
            root, config, aws = self.fixture()
            tags = [{'Key':k,'Value':v} for k,v in {'Project':'kamui','Network':'sepolia','SetupRun':'a'*32,'Role':'backend'}.items()]
            address = {'_role':'backend','AllocationId':'eipalloc-00000001','Domain':'vpc','PublicIp':'8.8.8.8','Tags':tags}
            if failure == 'foreign':
                address.update(InstanceId=aws.instances['backend']['InstanceId'], NetworkInterfaceId='eni-00000001', PrivateIpAddress='10.68.0.11', AssociationId='eipassoc-00000001')
                address['Tags'][0]['Value'] = 'someone-else'
                aws.addresses.append(address)
            else: aws.addresses.extend([address, copy.deepcopy(address)])
            with self.assertRaises(ValueError): addresses.assign(root, config, aws)
            self.assertEqual(aws.mutations(), [])

    def test_changed_saved_launch_and_broad_permissions_fail_closed(self):
        root, config, aws = self.fixture()
        path = root/'backend-launch'/'backend-instance.json'; path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'PRIVATE_FILE_REQUIRED'):
            addresses.assign(root, config, aws)
        self.assertEqual(aws.mutations(), [])

if __name__ == '__main__':
    unittest.main()
