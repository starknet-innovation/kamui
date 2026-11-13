"""Private operator transport and one-shot CloudFormation/SSM reconciliation.

This module is used only by user-run installation scripts. It cannot fetch
Secrets Manager values, log ECR passwords, or upload runtime/secret files.
"""
import base64
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('kamui_setup_install_base', HERE.parent/'setup/setup_resources.py')
base = importlib.util.module_from_spec(spec); spec.loader.exec_module(base)
read_private, write_private, private_dir = base.read_private, base.write_private, base.private_dir
REGION = base.REGION
AwsError = base.AwsError
EXTRA = {('ecr', 'describe-images'), ('ecr', 'describe-repositories'), ('ecr', 'batch-get-image'),
         ('s3api', 'head-object'), ('ssm', 'describe-instance-information'),
         ('ssm', 'describe-document'), ('ssm', 'list-command-invocations'),
         ('ssm', 'get-command-invocation'), ('ssm', 'send-command'),
         # Metadata only. Values are written by put_secret_value and never read back here.
         ('secretsmanager', 'describe-secret')}
# Reboot tooling (reopen.py). Each run observes the host again, like 'verify': the host
# programs are idempotent and re-check everything, so only an uncertain send is reconciled.
REBOOT_LABELS = {'inspect', 'fence', 'reopen', 'enable-boot', 'reload-runtime'}
SECRET_ARN = re.compile(r'arn:aws:secretsmanager:eu-west-1:[0-9]{12}:secret:kamui-sepolia/(backend|pepper)/[a-z-]+-[A-Za-z0-9]{6}')


def sha(data): return hashlib.sha256(data).hexdigest()


class Aws:
    def __init__(self, root, execute=subprocess.run):
        self.root = private_dir(root)
        self.directory = private_dir(self.root/'installation')
        self.logs = private_dir(self.directory/'aws-private')
        self.execute = execute

    def request(self, profile, service, operation, inputs):
        if (service, operation) not in base.READS | {('cloudformation', 'create-stack')} | EXTRA:
            raise ValueError('INSTALL_AWS_OPERATION_REFUSED')
        if service == 'ssm' and operation not in {op for svc, op in EXTRA if svc == 'ssm'}:
            raise ValueError('INSTALL_PRIVATE_PARAMETER_READ_REFUSED')
        return self._call(profile, service, operation, inputs)

    def put_secret_value(self, profile, secret_arn, text, token):
        """Store one secret value. The only Secrets Manager write; there is no read of a value.

        The log keeps the secret's ARN, the request token and the value's SHA-256, never the value:
        the real request goes through a temporary private file deleted as soon as the call returns.
        Reusing the same token with the same value is idempotent in Secrets Manager, so a lost
        response is safely resent rather than reconciled by reading the secret back.
        """
        if not SECRET_ARN.fullmatch(secret_arn) or not re.fullmatch(r'[A-Za-z0-9-]{32,64}', token):
            raise ValueError('INSTALL_SECRET_REQUEST_INVALID')
        if not isinstance(text, str) or len(text.encode()) > 60000: raise ValueError('INSTALL_SECRET_VALUE_INVALID')
        record = {'SecretId': secret_arn, 'ClientRequestToken': token, 'SecretStringSha256': sha(text.encode())}
        return self._call(profile, 'secretsmanager', 'put-secret-value',
                          {'SecretId': secret_arn, 'ClientRequestToken': token, 'SecretString': text}, record=record)

    def _call(self, profile, service, operation, inputs, body=None, record=None):
        if not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', profile): raise ValueError('INSTALL_PROFILE_INVALID')
        stem = uuid.uuid4().hex
        write_private(self.logs/(stem+'-operation.json'), {'profile': profile, 'service': service, 'operation': operation})
        if record is None:
            path = self.logs/(stem+'-request.json'); write_private(path, inputs)
        else:
            # A request holding a secret value: log a redacted record, send the real one once.
            write_private(self.logs/(stem+'-request.json'), record)
            path = self.logs/('.'+stem+'-transient-input.json'); write_private(path, inputs)
        command = ['aws', service, operation, '--profile', profile, '--region', REGION, '--output', 'json',
                   '--no-cli-pager', '--no-cli-auto-prompt', '--cli-connect-timeout', '5', '--cli-read-timeout', '30',
                   '--cli-input-json', 'file://'+str(path)]
        if body is not None: command += ['--body', str(body)]
        try:
            try: result = self.execute(command, capture_output=True, timeout=60, env=base.environment())
            finally:
                if record is not None and path.exists(): path.unlink(); base.sync(self.logs)
        except (OSError, subprocess.TimeoutExpired):
            write_private(self.logs/(stem+'-uncertain.json'), {'outcome': 'unknown'})
            raise AwsError('INSTALL_AWS_UNCERTAIN', True) from None
        for suffix, data in [('stdout', result.stdout), ('stderr', result.stderr)]:
            fd = os.open(self.logs/(stem+'-'+suffix), os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as out: out.write(data); out.flush(); os.fsync(out.fileno())
        base.sync(self.logs)
        if result.returncode:
            if operation == 'describe-stacks' and re.search(rb'\(ValidationError\).*Stack with id [^\r\n]+ does not exist', result.stderr):
                raise AwsError('STACK_NOT_FOUND')
            match = re.search(rb'An error occurred \(([A-Za-z0-9]+)\)', result.stderr)
            code = match[1].decode() if match else 'INSTALL_AWS_FAILED'
            raise AwsError(code, operation in {'create-stack', 'send-command', 'put-object', 'put-secret-value'})
        try: return json.loads(result.stdout or b'{}')
        except Exception: raise AwsError('INSTALL_AWS_RESPONSE_INVALID', True) from None

    def put_public_file(self, profile, bucket, owner, key, path):
        # Separate API: no general upload method accepting arbitrary secret paths.
        path = Path(path)
        package = self.directory/'package'
        allowed = {'backend.tar.gz', 'pepper.tar.gz', 'backend-manifest.json', 'pepper-manifest.json', 'host-install.py', 'pull-images.py', 'compose-linux-x86_64'}
        if path.resolve().parent != package.resolve() or path.is_symlink() or path.name not in allowed:
            raise ValueError('PUBLIC_PACKAGE_UPLOAD_ONLY')
        if not re.fullmatch(r'installation/[a-f0-9]{64}/[a-zA-Z0-9._-]+', key): raise ValueError('PUBLIC_ARTIFACT_KEY_INVALID')
        info = path.stat()
        if not path.is_file() or info.st_size > 200 * 1024 * 1024: raise ValueError('PUBLIC_ARTIFACT_INVALID')
        content_hash = sha(path.read_bytes())
        if key.split('/')[1] != content_hash: raise ValueError('PUBLIC_ARTIFACT_HASH_MISMATCH')
        checksum = base64.b64encode(bytes.fromhex(content_hash)).decode()
        head = {'Bucket': bucket, 'Key': key, 'ExpectedBucketOwner': owner, 'ChecksumMode': 'ENABLED'}
        def observed():
            try: return self.request(profile, 's3api', 'head-object', head)
            except AwsError as error:
                if error.code in {'404', 'NoSuchKey', 'NotFound'}: return None
                raise
        def matches(value):
            return value.get('ContentLength') == info.st_size and value.get('ChecksumSHA256') == checksum and value.get('Metadata', {}).get('sha256') == content_hash
        current = observed()
        if current is not None:
            if not matches(current): raise ValueError('PUBLIC_ARTIFACT_CHANGED')
            return
        request = {'Bucket': bucket, 'Key': key, 'ExpectedBucketOwner': owner, 'IfNoneMatch': '*',
                   'ChecksumSHA256': checksum, 'Metadata': {'sha256': content_hash}}
        intent = package/(sha((bucket+'\0'+key).encode())+'-upload-intent.json')
        if intent.exists(): raise ValueError('PUBLIC_UPLOAD_UNCERTAIN_RECONCILE_ONLY')
        write_private(intent, request)
        self._call(profile, 's3api', 'put-object', request, body=path)
        current = observed()
        if current is None or not matches(current): raise ValueError('PUBLIC_UPLOAD_PENDING_RECONCILE_ONLY')


class Driver:
    def __init__(self, root, aws, sleep=time.sleep, polls=120):
        self.root, self.aws, self.sleep, self.polls = Path(root), aws, sleep, polls
        self.directory = private_dir(private_dir(self.root/'installation')/'operations')
        self.config = json.loads(read_private(self.root/'aws-input.json'))
        self.plan = json.loads(read_private(self.root/'resources-setup/plan.json'))
        if self.config.get('version') != 1 or self.config.get('region') != REGION or self.plan.get('region') != REGION:
            raise ValueError('INSTALL_SEPOLIA_REGION_PLAN_REQUIRED')
        if not re.fullmatch('[a-f0-9]{32}', self.plan.get('runId', '')): raise ValueError('INSTALL_SETUP_RUN_REQUIRED')
        for role in ['backend', 'pepper']:
            original = self.plan['config'][role]
            if any(self.config[role].get(k) != original.get(k) for k in ['aws_profile', 'expected_account']):
                raise ValueError('INSTALL_RETAINED_IDENTITY_CHANGED')
        self.identities()

    def identities(self):
        accounts = []
        for role in ['backend', 'pepper']:
            v = self.config[role]
            if not re.fullmatch('[0-9]{12}', v.get('expected_account', '')): raise ValueError('INSTALL_EXPECTED_ACCOUNT_REQUIRED')
            result = self.aws.request(v['aws_profile'], 'sts', 'get-caller-identity', {})
            if result.get('Account') != v['expected_account']: raise ValueError('INSTALL_ACCOUNT_MISMATCH')
            accounts.append(v['expected_account'])
        if len(set(accounts)) != 2: raise ValueError('INSTALL_DISTINCT_ACCOUNTS_REQUIRED')

    def stack(self, role, kind, template, parameters):
        if role not in {'backend', 'pepper'} or kind != 'release': raise ValueError('INSTALL_STACK_SCOPE_INVALID')
        self.identities()
        name = f'kamui-sepolia-{role}-release-{self.plan["runId"][:12]}'
        profile = self.config[role]['aws_profile']
        request = {'StackName': name, 'TemplateBody': json.dumps(template),
                   'Parameters': [{'ParameterKey': k, 'ParameterValue': v} for k, v in sorted(parameters.items())],
                   'ClientRequestToken': 'kamui-release-'+self.plan['runId']+'-'+role,
                   'Capabilities': ['CAPABILITY_NAMED_IAM'], 'EnableTerminationProtection': True, 'TimeoutInMinutes': 30,
                   'Tags': [{'Key': 'Project', 'Value': 'kamui'}, {'Key': 'Network', 'Value': 'sepolia'},
                            {'Key': 'Role', 'Value': role}, {'Key': 'SetupRun', 'Value': self.plan['runId']}]}
        intent = self.directory/(role+'-release-stack-intent.json')
        def observed():
            try: value = self.aws.request(profile, 'cloudformation', 'describe-stacks', {'StackName': name})
            except AwsError as error:
                if error.code == 'STACK_NOT_FOUND': return None
                raise
            stacks = value.get('Stacks', [])
            if len(stacks) != 1 or stacks[0].get('StackName') != name or stacks[0].get('Tags') != request['Tags']:
                # Tags may be returned in another order.
                if len(stacks) != 1 or stacks[0].get('StackName') != name or sorted(stacks[0].get('Tags', []), key=lambda x:x['Key']) != sorted(request['Tags'], key=lambda x:x['Key']):
                    raise ValueError('INSTALL_STACK_BINDING_MISMATCH')
            return stacks[0]
        if intent.exists():
            if json.loads(read_private(intent)) != request: raise ValueError('INSTALL_STACK_REQUEST_CHANGED')
        else:
            if observed() is not None: raise ValueError('INSTALL_STACK_COLLISION')
            self.aws.request(profile, 'cloudformation', 'validate-template', {'TemplateBody': request['TemplateBody']})
            write_private(intent, request)
            print('CREATING_'+role.upper()+'_RELEASE_STACK', flush=True)
            self.aws.request(profile, 'cloudformation', 'create-stack', request)
        for index in range(self.polls):
            stack = observed()
            if stack and stack.get('StackStatus') == 'CREATE_COMPLETE':
                body = self.aws.request(profile, 'cloudformation', 'get-template', {'StackName': name, 'TemplateStage': 'Original'})['TemplateBody']
                if isinstance(body, str): body = json.loads(body)
                if body != template: raise ValueError('INSTALL_DEPLOYED_TEMPLATE_CHANGED')
                actual = {x['ParameterKey']:x['ParameterValue'] for x in stack.get('Parameters', [])}
                if any(actual.get(k) != v for k, v in parameters.items()): raise ValueError('INSTALL_STACK_PARAMETERS_CHANGED')
                return {x['OutputKey']:x['OutputValue'] for x in stack.get('Outputs', [])}
            if stack and stack.get('StackStatus') != 'CREATE_IN_PROGRESS': raise ValueError('INSTALL_STACK_FAILED_KEEP_STATE')
            if index + 1 < self.polls: self.sleep(5)
        raise ValueError('INSTALL_STACK_PENDING_RECONCILE_SAME_STEP')

    def command(self, role, label, instance, command):
        """Exactly one SendCommand; unknown results only reconcile by Comment.

        Reboot labels also return the command's standard output for the caller to parse."""
        self.identities()
        if role not in {'backend', 'pepper'} or label not in {'install', 'verify'} | REBOOT_LABELS or not re.fullmatch(r'i-[0-9a-f]{8,17}', instance):
            raise ValueError('INSTALL_COMMAND_SCOPE_INVALID')
        target = self.target(role)
        if target['InstanceId'] != instance: raise ValueError('INSTALL_COMMAND_TARGET_CHANGED')
        profile = self.config[role]['aws_profile']
        fingerprint = sha(command.encode())
        stem = role+'-'+label+'-'+fingerprint[:16]
        sequence = None
        if label != 'install':
            # A new explicit verification must observe the host again. Only an
            # unfinished/uncertain verification reuses its old command intent.
            for sequence in range(10000):
                candidate = stem+'-'+str(sequence)
                if not (self.directory/(candidate+'-verified.json')).exists() and not (self.directory/(candidate+'-terminal.json')).exists():
                    stem = candidate; break
            else: raise ValueError('INSTALL_VERIFICATION_HISTORY_EXHAUSTED')
        intent = self.directory/(stem+'-intent.json')
        comment = 'kamui-'+label+'-'+self.plan['runId']+'-'+fingerprint[:16]
        if sequence is not None: comment += '-'+str(sequence)
        document = self.aws.request(profile, 'ssm', 'describe-document', {'Name': 'AWS-RunShellScript', 'DocumentVersion': '1'})['Document']
        if document.get('Name') != 'AWS-RunShellScript' or document.get('DocumentVersion') != '1' or document.get('HashType') != 'Sha256' or not re.fullmatch('[a-f0-9]{64}', document.get('Hash', '')):
            raise ValueError('INSTALL_SSM_DOCUMENT_PIN_INVALID')
        request = {'DocumentName': 'AWS-RunShellScript', 'DocumentVersion': '1', 'DocumentHash': document['Hash'],
                   'DocumentHashType': 'Sha256', 'InstanceIds': [instance], 'Comment': comment,
                   'Parameters': {'commands': [command], 'executionTimeout': ['1800']},
                   'TimeoutSeconds': 600, 'MaxConcurrency': '1', 'MaxErrors': '0',
                   'CloudWatchOutputConfig': {'CloudWatchOutputEnabled': False}}
        command_id = None
        if intent.exists():
            saved = json.loads(read_private(intent))
            if saved['request'] != request: raise ValueError('INSTALL_COMMAND_REQUEST_CHANGED')
            token = None; matches = []
            for _ in range(20):
                query = {'InstanceId': instance, 'Details': False, 'MaxResults': 50,
                         'Filters': [{'key': 'InvokedAfter', 'value': saved['createdAt']}]}
                if token: query['NextToken'] = token
                reply = self.aws.request(profile, 'ssm', 'list-command-invocations', query)
                matches += [x for x in reply.get('CommandInvocations', []) if x.get('Comment') == comment and x.get('InstanceId') == instance and x.get('DocumentName') == 'AWS-RunShellScript']
                token = reply.get('NextToken')
                if not token: break
            if token or len(matches) != 1: raise ValueError('INSTALL_COMMAND_UNCERTAIN_RECONCILE_ONLY')
            command_id = matches[0]['CommandId']
        else:
            information = self.aws.request(profile, 'ssm', 'describe-instance-information', {'Filters': [{'Key': 'InstanceIds', 'Values': [instance]}]})
            nodes = information.get('InstanceInformationList', [])
            if len(nodes) != 1 or nodes[0].get('InstanceId') != instance or nodes[0].get('PingStatus') != 'Online': raise ValueError('INSTALL_SSM_NODE_NOT_ONLINE')
            created = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=1)
            write_private(intent, {'request': request, 'createdAt': created.isoformat()})
            print('SENDING_'+role.upper()+'_'+label.upper()+'_COMMAND', flush=True)
            response = self.aws.request(profile, 'ssm', 'send-command', request)
            write_private(self.directory/(stem+'-response.json'), response)
            command_id = response.get('Command', {}).get('CommandId')
        if not isinstance(command_id, str) or not re.fullmatch('[a-f0-9-]{36}', command_id): raise ValueError('INSTALL_COMMAND_ID_INVALID')
        for index in range(self.polls):
            try: reply = self.aws.request(profile, 'ssm', 'get-command-invocation', {'CommandId': command_id, 'InstanceId': instance})
            except AwsError as error:
                if error.code != 'InvocationDoesNotExist': raise
                reply = {'Status': 'Pending'}
            if reply.get('Status') == 'Success':
                if reply.get('InstanceId') != instance or reply.get('CommandId') != command_id or reply.get('ResponseCode') != 0:
                    raise ValueError('INSTALL_COMMAND_RESULT_MISMATCH')
                target = self.directory/(stem+'-verified.json')
                result = {'status': 'success', 'commandId': command_id, 'instanceId': instance, 'commandSha256': fingerprint}
                if target.exists():
                    if json.loads(read_private(target)) != result: raise ValueError('INSTALL_COMMAND_EVIDENCE_CHANGED')
                else: write_private(target, result)
                if label in REBOOT_LABELS: return {**result, 'output': reply.get('StandardOutputContent', '')}
                return result
            if reply.get('Status') not in {'Pending', 'InProgress', 'Delayed'}:
                if label != 'install':
                    target = self.directory/(stem+'-terminal.json')
                    if not target.exists(): write_private(target, {'status': 'failed', 'commandId': command_id})
                raise ValueError('INSTALL_COMMAND_FAILED_KEEP_PRIVATE_LOGS')
            if index % 12 == 0: print('WAITING_'+role.upper()+'_'+label.upper()+'_COMMAND', flush=True)
            if index + 1 < self.polls: self.sleep(5)
        raise ValueError('INSTALL_COMMAND_PENDING_RECONCILE_SAME_STEP')

    def target(self, role):
        if role not in {'backend', 'pepper'}: raise ValueError('INSTALL_ROLE_INVALID')
        spec = importlib.util.spec_from_file_location('kamui_install_target', HERE.parent/'setup/addresses.py')
        value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
        return value.instance(self.root, role, self.config[role], self.aws)
