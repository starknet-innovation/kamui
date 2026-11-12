#!/usr/bin/env python3
"""Operator-run Sepolia prerequisites. Never creates accounts or signing keys.

All AWS request bodies/results/errors stay private. A persisted create intent can
only be reconciled after interruption, never automatically submitted a second time.
"""
import argparse
import copy
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time
import uuid

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
REGION = 'eu-west-1'
AMI_PARAMETER = '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64'
ROLES = ('backend', 'pepper')
READS = {('sts', 'get-caller-identity'), ('ssm', 'get-parameter'),
         ('ec2', 'describe-images'), ('ec2', 'describe-availability-zones'),
         ('kms', 'describe-key'), ('kms', 'get-key-policy'),
         ('cloudformation', 'validate-template'), ('cloudformation', 'describe-stacks'),
         ('cloudformation', 'get-template'), ('ec2', 'describe-instances'),
         ('ec2', 'describe-addresses'), ('ec2', 'describe-subnets'),
         ('ec2', 'describe-route-tables'), ('ec2', 'describe-security-groups'),
         ('iam', 'get-instance-profile'), ('s3api', 'head-bucket'),
         ('s3api', 'get-public-access-block'), ('s3api', 'get-bucket-encryption')}
WRITES = {('cloudformation', 'create-stack'), ('ec2', 'allocate-address'),
          ('ec2', 'associate-address')}


class AwsError(Exception):
    def __init__(self, code, uncertain=False):
        self.code, self.uncertain = code, uncertain
        super().__init__(code)


def private_dir(path):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path:
        raise ValueError('PRIVATE_DIRECTORY_REQUIRED')
    path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('PRIVATE_DIRECTORY_REQUIRED')
    return path


def sync(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


def read_private(path, limit=262144):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size > limit:
            raise ValueError('PRIVATE_FILE_REQUIRED')
        data = os.read(fd, limit + 1)
        if len(data) > limit: raise ValueError('PRIVATE_FILE_TOO_LARGE')
        return data
    finally: os.close(fd)


def write_private(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(value, output, indent=2); output.write('\n'); output.flush(); os.fsync(output.fileno())
    sync(Path(path).parent)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def environment():
    blocked = {'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN',
               'AWS_ROLE_ARN', 'AWS_ROLE_SESSION_NAME', 'AWS_WEB_IDENTITY_TOKEN_FILE',
               'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI',
               'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE'}
    result = {k: v for k, v in os.environ.items() if k not in blocked and not k.startswith('AWS_ENDPOINT_URL')}
    result.update(AWS_MAX_ATTEMPTS='1', AWS_RETRY_MODE='standard', AWS_EC2_METADATA_DISABLED='true',
                  AWS_IGNORE_CONFIGURED_ENDPOINT_URLS='true', AWS_PAGER='', AWS_CLI_AUTO_PROMPT='off')
    return result


class Aws:
    def __init__(self, directory): self.directory = private_dir(directory)

    def request(self, profile, service, operation, inputs):
        if (service, operation) not in READS | WRITES or not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', profile):
            raise ValueError('AWS_OPERATION_REFUSED')
        if service == 'ssm' and (inputs.get('Name') != AMI_PARAMETER or inputs.get('WithDecryption') is not False):
            raise ValueError('PUBLIC_AMI_PARAMETER_ONLY')
        stem = uuid.uuid4().hex
        request = self.directory/(stem+'-request.json')
        write_private(request, inputs)
        write_private(self.directory/(stem+'-operation.json'), {'profile': profile, 'service': service, 'operation': operation})
        command = ['aws', service, operation, '--profile', profile, '--region', REGION,
                   '--output', 'json', '--no-cli-pager', '--no-cli-auto-prompt',
                   '--cli-connect-timeout', '5', '--cli-read-timeout', '25',
                   '--cli-input-json', 'file://'+str(request)]
        try:
            result = subprocess.run(command, capture_output=True, timeout=50, env=environment())
        except (subprocess.TimeoutExpired, OSError) as error:
            write_private(self.directory/(stem+'-uncertain.json'), {'operation': operation, 'outcome': 'unknown'})
            for label in ['stdout', 'stderr']:
                data = getattr(error, label, None)
                if data:
                    if isinstance(data, str): data = data.encode()
                    fd = os.open(self.directory/(stem+'-partial-'+label), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                    with os.fdopen(fd, 'wb') as output: output.write(data); output.flush(); os.fsync(output.fileno())
            raise AwsError('AWS_REQUEST_UNCERTAIN', (service, operation) in WRITES) from None
        for suffix, data in [('stdout', result.stdout), ('stderr', result.stderr)]:
            fd = os.open(self.directory/(stem+'-'+suffix), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as output: output.write(data); output.flush(); os.fsync(output.fileno())
        sync(self.directory)
        if result.returncode:
            # Only the specific DescribeStacks absence is safe to classify as absent.
            if service == 'cloudformation' and operation == 'describe-stacks' and re.search(rb'\(ValidationError\).*Stack with id [^\r\n]+ does not exist', result.stderr):
                raise AwsError('STACK_NOT_FOUND')
            raise AwsError('AWS_'+service.replace('-', '_').upper()+'_'+operation.replace('-', '_').upper()+'_FAILED', (service, operation) in WRITES)
        try: return json.loads(result.stdout or b'{}')
        except Exception: raise AwsError('AWS_RESPONSE_INVALID', (service, operation) in WRITES) from None


def module(name):
    spec = importlib.util.spec_from_file_location('kamui_'+name, HERE.parent/'readiness'/(name+'.py'))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


class Setup:
    def __init__(self, root, aws, backend_record=None, pepper_env=None, sleep=time.sleep, polls=120):
        self.root = private_dir(root)
        self.directory = private_dir(self.root/'resources-setup')
        self.aws, self.sleep, self.polls = aws, sleep, polls
        self.backend_record = Path(backend_record or Path.home()/'.kamui-admin-sepolia/setup-config.json')
        self.pepper_env = Path(pepper_env or REPO/'services/pepper/.env.local')

    def plan(self):
        plan = json.loads(read_private(self.directory/'plan.json'))
        if plan.get('version') != 1 or plan.get('region') != REGION or not re.fullmatch('[a-f0-9]{32}', plan.get('runId', '')):
            raise ValueError('SETUP_PLAN_INVALID')
        if plan.get('templateHashes') != self.template_hashes(): raise ValueError('TEMPLATE_CHANGED_STOP')
        self.identities(plan['config'])
        return plan

    def template_hashes(self):
        return {name: digest(json.loads((HERE/(name+'.json')).read_text())) for name in ['network', 'identity-storage']}

    def identities(self, config):
        accounts = []
        for role in ROLES:
            values = config[role]
            expected = values['expected_account']
            if not re.fullmatch('[0-9]{12}', expected): raise ValueError('EXPECTED_ACCOUNT_REQUIRED')
            actual = self.aws.request(values['aws_profile'], 'sts', 'get-caller-identity', {})
            if actual.get('Account') != expected: raise ValueError('EXPECTED_ACCOUNT_MISMATCH')
            accounts.append(expected)
        if accounts[0] == accounts[1]: raise ValueError('TWO_DISTINCT_ACCOUNTS_REQUIRED')

    def reused(self, config):
        """Verify selected shapes before creating anything alongside them."""
        inspector = module('inspect_aws')
        for role in ROLES:
            v = config[role]; profile = v['aws_profile']
            if v['subnet_id']:
                subnets = self.aws.request(profile, 'ec2', 'describe-subnets', {'SubnetIds': [v['subnet_id']]}).get('Subnets', [])
                groups = self.aws.request(profile, 'ec2', 'describe-security-groups', {'GroupIds': [v['security_group_id']]}).get('SecurityGroups', [])
                if len(subnets) != 1 or len(groups) != 1 or subnets[0].get('State') != 'available' or not subnets[0].get('VpcId') or subnets[0]['VpcId'] != groups[0].get('VpcId') or not inspector.web_ingress_only(groups[0]):
                    raise ValueError('SELECTED_NETWORK_MISMATCH')
                tables = self.aws.request(profile, 'ec2', 'describe-route-tables', {'Filters': [{'Name': 'association.subnet-id', 'Values': [v['subnet_id']]}]}).get('RouteTables', [])
                if not tables:
                    tables = self.aws.request(profile, 'ec2', 'describe-route-tables', {'Filters': [{'Name': 'vpc-id', 'Values': [subnets[0]['VpcId']]}, {'Name': 'association.main', 'Values': ['true']}]}).get('RouteTables', [])
                if not any(r.get('DestinationCidrBlock') == '0.0.0.0/0' and str(r.get('GatewayId', '')).startswith('igw-') and r.get('State') == 'active' for table in tables for r in table.get('Routes', [])):
                    raise ValueError('SELECTED_PUBLIC_ROUTE_REQUIRED')
            if v['instance_profile_name']:
                profile_data = self.aws.request(profile, 'iam', 'get-instance-profile', {'InstanceProfileName': v['instance_profile_name']})
                if len(profile_data.get('InstanceProfile', {}).get('Roles', [])) != 1: raise ValueError('SELECTED_HOST_PROFILE_INVALID')
                if role == 'backend':
                    request = {'Bucket': v['backup_bucket'], 'ExpectedBucketOwner': v['expected_account']}
                    if self.aws.request(profile, 's3api', 'head-bucket', request).get('BucketRegion') != REGION: raise ValueError('SELECTED_BACKUP_REGION_MISMATCH')
                    pab = self.aws.request(profile, 's3api', 'get-public-access-block', request).get('PublicAccessBlockConfiguration', {})
                    if not all(pab.get(k) is True for k in ['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets']): raise ValueError('SELECTED_BACKUP_NOT_PRIVATE')
                    rules = self.aws.request(profile, 's3api', 'get-bucket-encryption', request).get('ServerSideEncryptionConfiguration', {}).get('Rules', [])
                    if not any(r.get('ApplyServerSideEncryptionByDefault', {}).get('SSEAlgorithm') in {'AES256', 'aws:kms', 'aws:kms:dsse'} for r in rules): raise ValueError('SELECTED_BACKUP_ENCRYPTION_REQUIRED')

    def prepare(self):
        if (self.directory/'plan.json').exists(): self.plan(); return
        input_path = self.root/'aws-input.json'
        initial = json.loads(read_private(input_path)) if input_path.exists() else json.loads((HERE.parent/'readiness/private-input.example.json').read_text())
        shape = json.loads((HERE.parent/'readiness/private-input.example.json').read_text())
        if set(initial) != set(shape) or initial.get('version') != 1 or initial.get('region') != REGION:
            raise ValueError('INPUT_SHAPE_INVALID')
        for role in ROLES:
            if not isinstance(initial.get(role), dict) or set(initial[role]) != set(shape[role]) or any(not isinstance(v, str) for v in initial[role].values()):
                raise ValueError('INPUT_SHAPE_INVALID')
        config = copy.deepcopy(initial)
        # Independent retained records, not a just-read STS response, pin the accounts.
        record = json.loads(read_private(self.backend_record))
        if record.get('version') != 1 or record.get('region') != REGION or not re.fullmatch('[0-9]{12}', record.get('account', '')):
            raise ValueError('BACKEND_RECORD_INVALID')
        source = read_private(self.pepper_env).decode()
        found = re.findall(r'^\s*(?:export\s+)?KMS_KEY_ID\s*=\s*([^\r\n]+)\s*$', source, re.MULTILINE)
        if len(found) != 1: raise ValueError('EXISTING_PEPPER_KEY_REQUIRED')
        key = found[0].strip()
        if key[:1] in ('\"', "'") and key[-1:] == key[:1]: key = key[1:-1]
        match = re.fullmatch(r'arn:aws:kms:eu-west-1:([0-9]{12}):key/[A-Za-z0-9-]+', key)
        if not match: raise ValueError('EXISTING_PEPPER_KEY_REGION_REQUIRED')
        for role, expected in [('backend', record['account']), ('pepper', match[1])]:
            values = config[role]
            if values['expected_account'] not in ('', expected): raise ValueError('RETAINED_IDENTITY_MISMATCH')
            values['expected_account'] = expected
            if not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', values['aws_profile']): raise ValueError('PROFILE_INVALID')
            # Never create a half-pair around a selected shared resource.
            for pair in [('subnet_id', 'security_group_id')] + ([('instance_profile_name', 'backup_bucket')] if role == 'backend' else []):
                if bool(values[pair[0]]) != bool(values[pair[1]]): raise ValueError('PARTIAL_RESOURCE_SELECTION_REFUSED')
            if bool(values['ami_id']) != bool(values['approved_ami_owner']): raise ValueError('PARTIAL_IMAGE_SELECTION_REFUSED')
        if config['pepper']['pepper_key_id'] not in ('', key): raise ValueError('EXISTING_PEPPER_KEY_MISMATCH')
        config['pepper']['pepper_key_id'] = key
        self.identities(config)
        self.reused(config)
        metadata = self.aws.request(config['pepper']['aws_profile'], 'kms', 'describe-key', {'KeyId': key}).get('KeyMetadata', {})
        if any(metadata.get(k) != v for k, v in {'Arn': key, 'KeySpec': 'HMAC_256', 'KeyUsage': 'GENERATE_VERIFY_MAC', 'KeyState': 'Enabled', 'KeyManager': 'CUSTOMER', 'Origin': 'AWS_KMS'}.items()):
            raise ValueError('EXISTING_PEPPER_KEY_METADATA_MISMATCH')
        zones = {}
        for role in ROLES:
            values = config[role]; profile = values['aws_profile']
            azs = self.aws.request(profile, 'ec2', 'describe-availability-zones', {'Filters': [{'Name': 'state', 'Values': ['available']}, {'Name': 'zone-type', 'Values': ['availability-zone']}]})
            available = sorted(a['ZoneName'] for a in azs.get('AvailabilityZones', []) if a.get('State') == 'available' and re.fullmatch('eu-west-1[a-z]', a.get('ZoneName', '')))
            if not available: raise ValueError('AVAILABLE_ZONE_REQUIRED')
            zones[role] = available[0]
            if not values['ami_id']:
                parameter = self.aws.request(profile, 'ssm', 'get-parameter', {'Name': AMI_PARAMETER, 'WithDecryption': False}).get('Parameter', {})
                if parameter.get('Name') != AMI_PARAMETER or not re.fullmatch('ami-[0-9a-f]{8,17}', parameter.get('Value', '')):
                    raise ValueError('OFFICIAL_IMAGE_PARAMETER_INVALID')
                images = self.aws.request(profile, 'ec2', 'describe-images', {'ImageIds': [parameter['Value']], 'Owners': ['amazon']}).get('Images', [])
            else:
                images = self.aws.request(profile, 'ec2', 'describe-images', {'ImageIds': [values['ami_id']], 'Owners': [values['approved_ami_owner']]}).get('Images', [])
            if len(images) != 1 or images[0].get('Architecture') != 'x86_64' or images[0].get('State') != 'available' or images[0].get('RootDeviceType') != 'ebs' or not re.fullmatch('[0-9]{12}', images[0].get('OwnerId', '')):
                raise ValueError('IMAGE_SHAPE_INVALID')
            image = images[0]
            if image.get('ImageId') != (values['ami_id'] or parameter['Value']): raise ValueError('IMAGE_PIN_MISMATCH')
            values.update(ami_id=image['ImageId'], approved_ami_owner=image['OwnerId'])
            for name in self.template_hashes():
                self.aws.request(profile, 'cloudformation', 'validate-template', {'TemplateBody': (HERE/(name+'.json')).read_text()})
        plan = {'version': 1, 'region': REGION, 'runId': uuid.uuid4().hex, 'config': config, 'zones': zones,
                'initialInput': initial, 'inputExisted': input_path.exists(), 'templateHashes': self.template_hashes()}
        write_private(self.directory/'plan.json', plan)

    def stack(self, plan, role, kind, parameters, allow_create=True):
        name = f'kamui-sepolia-{role}-{kind}-{plan["runId"][:12]}'
        profile = plan['config'][role]['aws_profile']
        path = self.directory/(role+'-'+kind+'-intent.json')
        template_name = 'network' if kind == 'network' else 'identity-storage'
        template = json.loads((HERE/(template_name+'.json')).read_text())
        request = {'StackName': name, 'TemplateBody': json.dumps(template),
                   'Parameters': [{'ParameterKey': k, 'ParameterValue': v} for k, v in sorted(parameters.items())],
                   'Tags': [{'Key': 'Project', 'Value': 'kamui'}, {'Key': 'Network', 'Value': 'sepolia'},
                            {'Key': 'Role', 'Value': role}, {'Key': 'SetupRun', 'Value': plan['runId']}],
                   'ClientRequestToken': 'kamui-'+plan['runId']+'-'+role+'-'+kind,
                   'EnableTerminationProtection': True, 'TimeoutInMinutes': 30}
        if kind == 'identity': request['Capabilities'] = ['CAPABILITY_NAMED_IAM']
        def observed():
            try: value = self.aws.request(profile, 'cloudformation', 'describe-stacks', {'StackName': name})
            except AwsError as error:
                if error.code == 'STACK_NOT_FOUND': return None
                raise
            stacks = value.get('Stacks', [])
            if len(stacks) != 1 or stacks[0].get('StackName') != name: raise ValueError('STACK_OBSERVATION_INVALID')
            found = stacks[0]
            if {x['Key']: x['Value'] for x in found.get('Tags', [])} != {x['Key']: x['Value'] for x in request['Tags']}:
                raise ValueError('STACK_OWNERSHIP_MISMATCH')
            return found
        if path.exists():
            if json.loads(read_private(path)) != request: raise ValueError('STACK_INTENT_CHANGED')
        else:
            if not allow_create: raise ValueError('STACK_NOT_PREPARED')
            if observed() is not None: raise ValueError('STACK_NAME_COLLISION')
            write_private(path, request)
            # The only mutation. Intent survives any exception or process interruption.
            print('CREATING_'+role.upper()+'_'+kind.upper()+'_STACK', flush=True)
            result = self.aws.request(profile, 'cloudformation', 'create-stack', request)
            write_private(self.directory/(role+'-'+kind+'-submitted.json'), result)
        for attempt in range(self.polls):
            current = observed()
            if current is None:
                if attempt + 1 < self.polls:
                    self.sleep(5); continue
                raise ValueError('STACK_SUBMISSION_UNCERTAIN_RECONCILE_ONLY')
            status = current.get('StackStatus')
            if status == 'CREATE_COMPLETE':
                actual = self.aws.request(profile, 'cloudformation', 'get-template', {'StackName': name, 'TemplateStage': 'Original'}).get('TemplateBody')
                if isinstance(actual, str): actual = json.loads(actual)
                if digest(actual) != digest(template): raise ValueError('DEPLOYED_TEMPLATE_MISMATCH')
                if {x['ParameterKey']: x['ParameterValue'] for x in current.get('Parameters', [])} != parameters:
                    # CloudFormation includes template defaults as well as supplied parameters.
                    supplied = {x['ParameterKey']: x['ParameterValue'] for x in current.get('Parameters', [])}
                    if any(supplied.get(k) != v for k, v in parameters.items()): raise ValueError('STACK_PARAMETERS_MISMATCH')
                return {x['OutputKey']: x['OutputValue'] for x in current.get('Outputs', [])}
            if status != 'CREATE_IN_PROGRESS': raise ValueError('STACK_FAILED_KEEP_PRIVATE_EVIDENCE')
            if attempt % 12 == 0: print('WAITING_'+role.upper()+'_'+kind.upper()+'_STACK', flush=True)
            if attempt + 1 < self.polls: self.sleep(5)
        raise ValueError('STACK_PENDING_RERUN_SAME_STEP_TO_POLL_ONLY')

    def network(self):
        plan = self.plan()
        self.reused(plan['config'])
        for role in ROLES:
            values = plan['config'][role]
            if values['subnet_id'] and values['security_group_id']: continue
            result = self.stack(plan, role, 'network', {'Role': role, 'AvailabilityZone': plan['zones'][role]})
            target = self.directory/(role+'-network-result.json')
            if target.exists():
                if json.loads(read_private(target)) != result: raise ValueError('NETWORK_OUTPUT_CHANGED')
            else: write_private(target, result)

    def identity(self):
        plan = self.plan()
        self.reused(plan['config'])
        for role in ROLES:
            values = plan['config'][role]
            if values['instance_profile_name']: continue
            result = self.stack(plan, role, 'identity', {'HostRole': role,
                'ExistingPepperKeyArn': values.get('pepper_key_id', ''),
                'BackupBucketName': 'kamui-sepolia-backup-'+plan['runId'] if role == 'backend' else ''})
            target = self.directory/(role+'-identity-result.json')
            if target.exists():
                if json.loads(read_private(target)) != result: raise ValueError('IDENTITY_OUTPUT_CHANGED')
            else: write_private(target, result)

    def export(self):
        plan = self.plan(); config = copy.deepcopy(plan['config'])
        for role in ROLES:
            values = config[role]
            if not values['subnet_id']:
                result = json.loads(read_private(self.directory/(role+'-network-result.json')))
                if result != self.stack(plan, role, 'network', {'Role': role, 'AvailabilityZone': plan['zones'][role]}, allow_create=False):
                    raise ValueError('NETWORK_OUTPUT_CHANGED')
                values.update(subnet_id=result['SubnetId'], security_group_id=result['SecurityGroupId'])
            if not values['instance_profile_name']:
                result = json.loads(read_private(self.directory/(role+'-identity-result.json')))
                if result != self.stack(plan, role, 'identity', {'HostRole': role,
                        'ExistingPepperKeyArn': values.get('pepper_key_id', ''),
                        'BackupBucketName': 'kamui-sepolia-backup-'+plan['runId'] if role == 'backend' else ''}, allow_create=False):
                    raise ValueError('IDENTITY_OUTPUT_CHANGED')
                values['instance_profile_name'] = result['InstanceProfileName']
                if role == 'backend': values['backup_bucket'] = result['BackupBucketName']
        self.pepper_policy(config)
        # No export until actual existing/new resources pass the same consumer inspector.
        inspector = module('inspect_aws')
        report = inspector.inspect(config, self.aws)
        write_private(self.directory/('inventory-'+uuid.uuid4().hex+'.json'), report)
        if not report['all_observed_checks_passed']: raise ValueError('RESOURCE_INVENTORY_NOT_PASSED')
        path = self.root/'aws-input.json'
        if path.exists():
            current = json.loads(read_private(path))
            if current == config: return
            if current != plan['initialInput']: raise ValueError('PRIVATE_INPUT_CHANGED_REFUSE_OVERWRITE')
            backup = self.directory/'aws-input-before.json'
            if not backup.exists(): write_private(backup, current)
        elif plan['inputExisted']: raise ValueError('PRIVATE_INPUT_DISAPPEARED')
        temp = self.root/('.aws-input-'+uuid.uuid4().hex+'.json')
        write_private(temp, config)
        os.replace(temp, path); sync(self.root)
        print('AWS_INPUT_READY_RESOURCES_OBSERVED_NOT_DEPLOYED')

    def pepper_policy(self, config):
        values = config['pepper']
        profile = self.aws.request(values['aws_profile'], 'iam', 'get-instance-profile',
                                   {'InstanceProfileName': values['instance_profile_name']})
        roles = profile.get('InstanceProfile', {}).get('Roles', [])
        if len(roles) != 1 or not re.fullmatch(r'arn:aws:iam::'+values['expected_account']+r':role/[A-Za-z0-9+=,.@_/-]+', roles[0].get('Arn', '')):
            raise ValueError('PEPPER_HOST_ROLE_INVALID')
        role_arn = roles[0]['Arn']
        value = self.aws.request(values['aws_profile'], 'kms', 'get-key-policy',
                                 {'KeyId': values['pepper_key_id'], 'PolicyName': 'default'})
        policy = json.loads(value['Policy']) if isinstance(value.get('Policy'), str) else value.get('Policy')
        # Conservative shape check, not a general IAM evaluator. Complex policies
        # require operator review; never rewrite an existing pepper key's policy.
        if not isinstance(policy, dict) or not isinstance(policy.get('Statement'), list):
            raise ValueError('PEPPER_KEY_POLICY_REVIEW_REQUIRED')
        root_arn = 'arn:aws:iam::'+values['expected_account']+':root'
        granted = set()
        required = {'kms:GenerateMac', 'kms:VerifyMac', 'kms:DescribeKey'}
        for statement in policy['Statement']:
            if statement.get('Effect') == 'Deny': raise ValueError('PEPPER_KEY_POLICY_REVIEW_REQUIRED')
            principal = statement.get('Principal', {})
            principals = principal.get('AWS', []) if isinstance(principal, dict) else []
            if isinstance(principals, str): principals = [principals]
            resources = statement.get('Resource', [])
            if isinstance(resources, str): resources = [resources]
            if statement.get('Effect') != 'Allow' or statement.get('Condition') or not ({root_arn, role_arn} & set(principals)) or not ({'*', values['pepper_key_id']} & set(resources)):
                continue
            actions = statement.get('Action', [])
            if isinstance(actions, str): actions = [actions]
            for action in required:
                if action in actions or 'kms:*' in actions or '*' in actions: granted.add(action)
        if granted != required: raise ValueError('PEPPER_KEY_POLICY_REVIEW_REQUIRED')
        # This does not simulate SCPs/permissions boundaries or exercise KMS MACs.

    def launch(self, provision_run=None, instance_reader=None):
        # Run this separate paid phase only after the operator reviewed the plan.
        self.export()
        config = json.loads(read_private(self.root/'aws-input.json'))
        spec = importlib.util.spec_from_file_location('kamui_addresses', HERE/'addresses.py')
        addresses = importlib.util.module_from_spec(spec); spec.loader.exec_module(addresses)
        spec = importlib.util.spec_from_file_location('kamui_launch', HERE.parent/'scripts/provision.py')
        provision = importlib.util.module_from_spec(spec); spec.loader.exec_module(provision)
        provision_run = provision_run or provision.run
        instance_reader = instance_reader or addresses.instance
        for role in ROLES:
            directory = private_dir(self.root/(role+'-launch'))
            intent = directory/(role+'-launch-intent.json')
            if intent.exists():
                try: instance_reader(self.root, role, config[role], self.aws)
                except Exception: raise ValueError('HOST_LAUNCH_UNCERTAIN_RECONCILE_ONLY') from None
                print('EXISTING_'+role.upper()+'_HOST_VERIFIED')
                continue
            v = config[role]
            images = self.aws.request(v['aws_profile'], 'ec2', 'describe-images', {'ImageIds': [v['ami_id']], 'Owners': [v['approved_ami_owner']]}).get('Images', [])
            if len(images) != 1 or images[0].get('ImageId') != v['ami_id'] or images[0].get('OwnerId') != v['approved_ami_owner']:
                raise ValueError('REVIEWED_IMAGE_CHANGED')
            provision_run({'KAMUI_INFRA_REVIEWED': 'yes', 'KAMUI_ROLE': role, 'AWS_PROFILE': v['aws_profile'],
                           'EXPECTED_ACCOUNT': v['expected_account'], 'AMI_ID': v['ami_id'],
                           'SUBNET_ID': v['subnet_id'], 'SECURITY_GROUP_ID': v['security_group_id'],
                           'INSTANCE_PROFILE_NAME': v['instance_profile_name'], 'ROOT_DEVICE_NAME': images[0].get('RootDeviceName', ''),
                           'OPERATOR_PRIVATE_DIRECTORY': str(directory)})

    def status(self):
        plan = self.plan()
        print(json.dumps({'version': 1, 'prepared': True, 'networkResults': sum((self.directory/(r+'-network-result.json')).exists() for r in ROLES),
                          'identityResults': sum((self.directory/(r+'-identity-result.json')).exists() for r in ROLES),
                          'hostsLaunchedByThisCommand': False, 'approvalOrSecurityAudit': False}))

    def wait_hosts_running(self, config):
        self.identities(config)
        for role in ROLES:
            result = json.loads(read_private(self.root/(role+'-launch')/(role+'-instance.json')))
            instances = result.get('Instances', [])
            if len(instances) != 1 or not re.fullmatch(r'i-[0-9a-f]{8,17}', instances[0].get('InstanceId', '')):
                raise ValueError('HOST_LAUNCH_UNCERTAIN_RECONCILE_ONLY')
            identifier = instances[0]['InstanceId']
            for attempt in range(self.polls):
                observed = self.aws.request(config[role]['aws_profile'], 'ec2', 'describe-instances', {'InstanceIds': [identifier]})
                reservations = observed.get('Reservations', [])
                if len(reservations) != 1 or reservations[0].get('OwnerId') != config[role]['expected_account']:
                    raise ValueError('HOST_OWNER_MISMATCH')
                items = reservations[0].get('Instances', [])
                if len(items) != 1 or items[0].get('InstanceId') != identifier: raise ValueError('HOST_OBSERVATION_INVALID')
                state = items[0].get('State', {}).get('Name')
                if state == 'running': break
                if state != 'pending': raise ValueError('HOST_NOT_RUNNING_NO_ADDRESS_WRITE')
                if attempt + 1 == self.polls: raise ValueError('HOST_STARTING_RERUN_SAME_STEP_LATER')
                self.sleep(5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('step', choices=['all', 'prepare', 'network', 'identity', 'export', 'status', 'launch', 'addresses'])
    parser.add_argument('--private-directory', default=str(Path.home()/'.kamui-hosting-sepolia'))
    parser.add_argument('--backend-record')
    parser.add_argument('--pepper-env')
    options = parser.parse_args()
    root = private_dir(options.private_directory)
    directory = private_dir(root/'resources-setup')
    fd = os.open(directory/'.setup.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        setup = Setup(root, Aws(private_dir(directory/'aws-private')), options.backend_record, options.pepper_env)
        steps = ['prepare', 'network', 'identity', 'export'] if options.step == 'all' else [options.step]
        for step in steps:
            print('STEP_'+step.upper(), flush=True)
            if step == 'addresses':
                import addresses
                setup.export()
                config = json.loads(read_private(root/'aws-input.json'))
                setup.wait_hosts_running(config)
                print(json.dumps(addresses.assign(root, config, setup.aws)))
            else: getattr(setup, step)()
        print('REQUESTED_SETUP_STEPS_COMPLETED')
    finally: os.close(fd)


if __name__ == '__main__':
    try: main()
    except Exception as error:
        code = str(error) if isinstance(error, (ValueError, AwsError)) and re.fullmatch('[A-Z_]{3,100}', str(error)) else 'SETUP_STOPPED_PRIVATE_EVIDENCE_RETAINED'
        print(code); raise SystemExit(1)
