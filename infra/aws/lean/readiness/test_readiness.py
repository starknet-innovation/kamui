import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent

def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE/(name+'.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

inventory = load('inspect_aws')
review = load('review')

def config():
    data = json.loads((HERE/'private-input.example.json').read_text())
    for i, role in enumerate(['backend', 'pepper'], 1):
        values=data[role]
        values.update(expected_account=str(i).zfill(12), approved_ami_owner=str(3).zfill(12),
                      ami_id='PRIVATE_AMI_SENTINEL', subnet_id='PRIVATE_SUBNET_SENTINEL',
                      security_group_id='PRIVATE_GROUP_SENTINEL', instance_profile_name='PRIVATE_PROFILE_SENTINEL')
    data['backend']['backup_bucket']='PRIVATE_BUCKET_SENTINEL'
    data['pepper']['pepper_key_id']=':'.join(['arn','aws','kms','eu-west-1',data['pepper']['expected_account'],'key/PRIVATE-KEY-SENTINEL'])
    return data

class FakeAws:
    def __init__(self, data):
        self.data=data; self.calls=[]
    def request(self, profile, service, operation, inputs):
        self.calls.append((profile,service,operation,inputs))
        role='backend' if profile==self.data['backend']['aws_profile'] else 'pepper'
        values=self.data[role]
        if operation=='get-caller-identity':return {'Account':values['expected_account'],'Arn':'PRIVATE_IDENTITY_SENTINEL'}
        if operation=='describe-images':return {'Images':[{'Architecture':'x86_64','State':'available','RootDeviceType':'ebs','OwnerId':values['approved_ami_owner']}]}
        if operation=='describe-subnets':return {'Subnets':[{'State':'available','VpcId':'PRIVATE_VPC_SENTINEL'}]}
        if operation=='describe-security-groups':return {'SecurityGroups':[{'VpcId':'PRIVATE_VPC_SENTINEL','IpPermissions':[{'IpProtocol':'tcp','FromPort':p,'ToPort':p} for p in [80,443]]}]}
        if operation=='describe-route-tables':return {'RouteTables':[{'Routes':[{'DestinationCidrBlock':'0.0.0.0/0','GatewayId':'igw-PRIVATE','State':'active'}]}]}
        if operation=='get-instance-profile':return {'InstanceProfile':{'Roles':[{'Arn':'PRIVATE_ROLE_SENTINEL'}]}}
        if operation=='describe-key':return {'KeyMetadata':{'KeySpec':'HMAC_256','KeyUsage':'GENERATE_VERIFY_MAC','Origin':'AWS_KMS','KeyManager':'CUSTOMER','KeyState':'Enabled','Arn':values['pepper_key_id']}}
        if operation=='head-bucket':return {'BucketRegion':'eu-west-1'}
        if operation=='get-public-access-block':return {'PublicAccessBlockConfiguration':dict.fromkeys(['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets'],True)}
        if operation=='get-bucket-encryption':return {'ServerSideEncryptionConfiguration':{'Rules':[{'ApplyServerSideEncryptionByDefault':{'SSEAlgorithm':'AES256'}}]}}
        raise AssertionError('unexpected operation')

class ReadinessTest(unittest.TestCase):
    def test_inventory_contains_only_labels_not_private_metadata(self):
        data=config(); client=FakeAws(data)
        result=inventory.inspect(data,client)
        self.assertTrue(result['all_observed_checks_passed'])
        self.assertFalse(result['deployment_approved'])
        text=json.dumps(result)
        for marker in ['PRIVATE_',data['backend']['expected_account'],data['pepper']['expected_account']]:self.assertNotIn(marker,text)
        self.assertTrue(all((service,operation) in inventory.READS for _,service,operation,_ in client.calls))

    def test_unexpected_identity_stops_role_resource_reads(self):
        data=config(); client=FakeAws(data); original=client.request
        client.request=lambda profile,service,operation,inputs: {'Account':'wrong'} if operation=='get-caller-identity' else original(profile,service,operation,inputs)
        result=inventory.inspect(data,client)
        self.assertFalse(result['all_observed_checks_passed'])
        self.assertEqual(client.calls,[])

    def test_private_inputs_and_kms_aliases_are_refused_before_requests(self):
        data=config(); data['pepper']['pepper_key_id']='alias/PRIVATE_ALIAS_SENTINEL'
        with self.assertRaisesRegex(ValueError,'EXISTING_PEPPER_KEY_REQUIRED'):inventory.inspect(data,FakeAws(data))
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'input.json';path.write_text(json.dumps(config()));path.chmod(0o644)
            with self.assertRaises(ValueError):inventory.load_private(path)
            path.chmod(0o600); self.assertEqual(inventory.load_private(path)['version'],1)

    def test_non_web_ports_ranges_and_all_protocols_fail(self):
        for permission in [{'IpProtocol':'-1'},{'IpProtocol':'tcp','FromPort':22,'ToPort':22},{'IpProtocol':'tcp','FromPort':80,'ToPort':443}]:
            self.assertFalse(inventory.web_ingress_only({'IpPermissions':[permission]}))

    def test_request_whitelist_rejects_mutations_without_invoking_aws(self):
        with patch.object(inventory.subprocess,'run') as run:
            with self.assertRaisesRegex(ValueError,'READ_OPERATION_REQUIRED'):inventory.Aws().request('fixture','ec2','run-instances',{})
            run.assert_not_called()

    def test_aws_failure_is_unavailable_without_echoing_error(self):
        data=config(); client=FakeAws(data)
        client.request=lambda *args: (_ for _ in ()).throw(RuntimeError('PRIVATE_FAILURE_SENTINEL'))
        result=inventory.inspect(data,client)
        self.assertNotIn('PRIVATE_FAILURE_SENTINEL',json.dumps(result))
        self.assertEqual(result['checks']['backend_account_matches'],'unavailable')

    def test_review_template_remains_incomplete_and_boolean_strings_do_not_approve(self):
        data=json.loads((HERE/'review.example.json').read_text())
        self.assertFalse(review.check(data)['record_complete'])
        data.update(monthlyPlanningUsd=100,registrySignerPlan='separate_offserver_manual_rotation',backupRetentionDays=7,logRetentionDays=7)
        for item in data['approvals'].values():item.update(owner='assigned role',reference='private-review',accepted=True)
        data['evidence']=dict.fromkeys(data['evidence'],'private-evidence')
        self.assertTrue(review.check(data)['record_complete'])
        data['registrySignerCustody']='kms_hosted_rotator'
        self.assertIn('kms_manual_operator_custody',review.check(data)['missing'])
        data['registrySignerCustody']='kms_secp256k1_manual_operator'
        data['approvals']['aws']['accepted']='false'
        self.assertFalse(review.check(data)['record_complete'])
        self.assertFalse(review.check(data)['deployment_executed'])

if __name__=='__main__':unittest.main()
