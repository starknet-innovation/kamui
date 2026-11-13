"""Installation integration boundaries. No AWS, Docker build, download or host changes."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import common


def load(name):
    spec = importlib.util.spec_from_file_location('install_test_'+name, Path(__file__).parent/(name+'.py'))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


workflow = load('install')
host = load('host_install')


class FakeAws:
    def __init__(self):
        self.accounts = {'backend-profile': '000000000001', 'pepper-profile': '000000000002'}
        self.stacks = {}; self.templates = {}; self.calls = []; self.invocations = []
        self.lose_stack = False; self.lose_command = False; self.command_recorded = True
        self.command_id = '11111111-1111-1111-1111-111111111111'

    def request(self, profile, service, operation, inputs):
        self.calls.append((profile, service, operation, copy.deepcopy(inputs)))
        if operation == 'get-caller-identity': return {'Account': self.accounts[profile]}
        if operation == 'validate-template': return {}
        if operation == 'describe-stacks':
            if inputs['StackName'] not in self.stacks: raise common.AwsError('STACK_NOT_FOUND')
            return {'Stacks': [self.stacks[inputs['StackName']]]}
        if operation == 'create-stack':
            self.stacks[inputs['StackName']] = {'StackName': inputs['StackName'], 'StackStatus': 'CREATE_COMPLETE',
                'Tags': inputs['Tags'], 'Parameters': inputs['Parameters'], 'Outputs': [{'OutputKey': 'Result', 'OutputValue': 'fixture'}]}
            self.templates[inputs['StackName']] = json.loads(inputs['TemplateBody'])
            if self.lose_stack:
                self.lose_stack = False; raise common.AwsError('INSTALL_AWS_UNCERTAIN', True)
            return {'StackId': 'private-fixture'}
        if operation == 'get-template': return {'TemplateBody': self.templates[inputs['StackName']]}
        if operation == 'describe-document': return {'Document': {'Name': 'AWS-RunShellScript', 'DocumentVersion': '1', 'HashType': 'Sha256', 'Hash': 'a'*64}}
        if operation == 'describe-instance-information': return {'InstanceInformationList': [{'InstanceId': inputs['Filters'][0]['Values'][0], 'PingStatus': 'Online'}]}
        if operation == 'send-command':
            if self.command_recorded:
                self.invocations.append({'CommandId': self.command_id, 'InstanceId': inputs['InstanceIds'][0], 'Comment': inputs['Comment'], 'DocumentName': inputs['DocumentName']})
            if self.lose_command:
                self.lose_command = False; raise common.AwsError('INSTALL_AWS_UNCERTAIN', True)
            return {'Command': {'CommandId': self.command_id}}
        if operation == 'list-command-invocations': return {'CommandInvocations': self.invocations}
        if operation == 'get-command-invocation': return {'CommandId': inputs['CommandId'], 'InstanceId': inputs['InstanceId'], 'Status': 'Success', 'ResponseCode': 0}
        raise AssertionError('unexpected fake operation')


class InstallationTest(unittest.TestCase):
    def fixture(self, directory):
        root = Path(directory).resolve(); (root/'resources-setup').mkdir(mode=0o700)
        config = {'version': 1, 'region': 'eu-west-1', 'backend': {'aws_profile': 'backend-profile', 'expected_account': '000000000001'},
                  'pepper': {'aws_profile': 'pepper-profile', 'expected_account': '000000000002'}}
        common.write_private(root/'aws-input.json', config)
        common.write_private(root/'resources-setup/plan.json', {'region': 'eu-west-1', 'runId': 'a'*32, 'config': config})
        aws = FakeAws(); driver = common.Driver(root, aws, sleep=lambda _: None, polls=1)
        driver.target = lambda role: {'InstanceId': 'i-0123456789abcdef0'}
        return root, aws, driver

    def test_lost_stack_response_reconciles_without_second_create(self):
        with tempfile.TemporaryDirectory() as d:
            _, aws, driver = self.fixture(d); aws.lose_stack = True
            template = {'Resources': {}}
            with self.assertRaises(common.AwsError): driver.stack('backend', 'release', template, {'HostRole': 'backend'})
            self.assertEqual(driver.stack('backend', 'release', template, {'HostRole': 'backend'}), {'Result': 'fixture'})
            self.assertEqual(sum(c[2] == 'create-stack' for c in aws.calls), 1)

    def test_changed_stack_payload_and_actual_template_block_reuse(self):
        with tempfile.TemporaryDirectory() as d:
            _, aws, driver = self.fixture(d); template = {'Resources': {}}
            driver.stack('backend', 'release', template, {'HostRole': 'backend'})
            with self.assertRaisesRegex(ValueError, 'INSTALL_STACK_REQUEST_CHANGED'):
                driver.stack('backend', 'release', template, {'HostRole': 'pepper'})
            next(iter(aws.templates.values()))['Description'] = 'drift'
            with self.assertRaisesRegex(ValueError, 'INSTALL_DEPLOYED_TEMPLATE_CHANGED'):
                driver.stack('backend', 'release', template, {'HostRole': 'backend'})

    def test_lost_remote_command_response_reconciles_exact_invocation_without_resend(self):
        with tempfile.TemporaryDirectory() as d:
            _, aws, driver = self.fixture(d); aws.lose_command = True
            with self.assertRaises(common.AwsError): driver.command('backend', 'install', 'i-0123456789abcdef0', 'public-reviewed-command')
            result = driver.command('backend', 'install', 'i-0123456789abcdef0', 'public-reviewed-command')
            self.assertEqual(result['status'], 'success')
            self.assertEqual(sum(c[2] == 'send-command' for c in aws.calls), 1)
            sent = next(c[3] for c in aws.calls if c[2] == 'send-command')
            self.assertFalse(sent['CloudWatchOutputConfig']['CloudWatchOutputEnabled'])
            query = next(c[3] for c in aws.calls if c[2] == 'list-command-invocations')
            self.assertIs(query['Details'], False)

    def test_unknown_remote_command_is_not_resent_and_wrong_target_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            _, aws, driver = self.fixture(d); aws.lose_command = True; aws.command_recorded = False
            with self.assertRaises(common.AwsError): driver.command('backend', 'install', 'i-0123456789abcdef0', 'public')
            with self.assertRaisesRegex(ValueError, 'INSTALL_COMMAND_UNCERTAIN_RECONCILE_ONLY'):
                driver.command('backend', 'install', 'i-0123456789abcdef0', 'public')
            with self.assertRaisesRegex(ValueError, 'INSTALL_COMMAND_TARGET_CHANGED'):
                driver.command('backend', 'install', 'i-99999999999999999', 'public')
            self.assertEqual(sum(c[2] == 'send-command' for c in aws.calls), 1)

    def test_account_drift_blocks_remote_command_and_stack_creation(self):
        with tempfile.TemporaryDirectory() as d:
            _, aws, driver = self.fixture(d); aws.accounts['pepper-profile'] = '000000000003'
            with self.assertRaisesRegex(ValueError, 'INSTALL_ACCOUNT_MISMATCH'):
                driver.command('backend', 'install', 'i-0123456789abcdef0', 'public')
            self.assertFalse(any(c[2] in {'send-command', 'create-stack'} for c in aws.calls))

    def test_each_completed_verification_is_followed_by_a_fresh_check(self):
        with tempfile.TemporaryDirectory() as d:
            _, aws, driver = self.fixture(d)
            driver.command('backend', 'verify', 'i-0123456789abcdef0', 'read-only-public-check')
            driver.command('backend', 'verify', 'i-0123456789abcdef0', 'read-only-public-check')
            sent = [c[3] for c in aws.calls if c[2] == 'send-command']
            self.assertEqual(len(sent), 2)
            self.assertNotEqual(sent[0]['Comment'], sent[1]['Comment'])

    def test_package_source_accepts_only_committed_infrastructure_fixes(self):
        def answer(changed):
            def execute(args,**kwargs):
                if args[1:3]==['rev-parse','HEAD']:return subprocess.CompletedProcess(args,0,'b'*40+'\n','')
                if args[1]=='status':return subprocess.CompletedProcess(args,0,'','')
                if args[1]=='merge-base':return subprocess.CompletedProcess(args,0,b'',b'')
                if args[1]=='diff':return subprocess.CompletedProcess(args,0,changed+'\0','')
                raise AssertionError('unexpected git operation')
            return execute
        with patch.object(workflow.subprocess,'run',side_effect=answer('infra/aws/lean/install/release.py')):
            workflow.committed_source('a'*40)
        with patch.object(workflow.subprocess,'run',side_effect=answer('services/backend/src/index.ts')):
            with self.assertRaisesRegex(ValueError,'INSTALL_APPLICATION_SOURCE_CHANGED'):workflow.committed_source('a'*40)

    def test_public_allowlist_package_is_consumed_by_host_verifier_without_runtime_data(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d).resolve(); repo = root/'repo'; repo.mkdir()
            for name in workflow.FILES:
                path = repo/'infra/aws/lean'/name; path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((workflow.REPO/'infra/aws/lean'/name).read_bytes())
            install = repo/'infra/aws/lean/install'; install.mkdir(parents=True)
            (install/'host_install.py').write_bytes((Path(__file__).parent/'host_install.py').read_bytes())
            (install/'image_pull.py').write_bytes((Path(__file__).parent/'image_pull.py').read_bytes())
            (install/'runtime-secret.env').write_text('PRIVATE_SENTINEL_MUST_NOT_UPLOAD')
            operator = root/'operator'; operator.mkdir(mode=0o700)
            value = {'schema': 'kamui.release.v1', 'architecture': 'linux/amd64', 'sourceRevision': 'a'*40,
                     'images': {k:'example.invalid/kamui@sha256:'+'b'*64 for k in ['CADDY_IMAGE','KEYCHAIN_IMAGE','BACKEND_IMAGE','PEPPER_IMAGE','POSTGRES_IMAGE']}}
            compose = b'fake-reviewed-linux-compose'
            with patch.object(workflow, 'committed_source'), patch.object(workflow, 'COMPOSE_SHA', common.sha(compose)):
                artifacts = workflow.package(operator, value, repo, compose_download=lambda: io.BytesIO(compose))
            for role in ['backend', 'pepper']:
                item = artifacts['roles'][role]
                raw = Path(item['manifest']['path']).read_bytes()
                parsed = host.parse_manifest(raw, item['manifest']['sha256'], role)
                dest = root/role; dest.mkdir()
                host.unpack_verified(Path(item['archive']['path']).read_bytes(), parsed, dest)
                # No runtime data: no secrets/ or runtime/ directory and no file named like one the
                # runtime step manages. Code that fetches them on the host is expected.
                managed = {Path(n).name for names in load('runtime').MANAGED_FILES.values() for n in names} | {'RELAYER_PRIVATE_KEY'}
                self.assertFalse(any({'secrets', 'runtime'} & set(Path(p).parts[:-1]) or Path(p).name in managed for p in parsed['files']))
                self.assertIn('scripts/secrets-sync.py', parsed['files'])
                self.assertNotIn(b'PRIVATE_SENTINEL', Path(item['archive']['path']).read_bytes())
            command = workflow.bootstrap('backend', 'fixture-release-bucket', artifacts, verify=True)
            self.assertIn('--check', command)
            self.assertNotIn('dnf -y install', command)
            self.assertNotIn('runtime', command.lower().replace('runtime_pending',''))
            subprocess.run(['sh', '-n'], input=command, text=True, capture_output=True, check=True)
            with self.assertRaises(ValueError): workflow.bootstrap('backend', 'bad;bucket', artifacts)

    def test_transport_refuses_secret_paths_and_auth_token_logging(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d).resolve(); aws = common.Aws(root)
            secret = root/'installation/runtime'; secret.mkdir(mode=0o700)
            path = secret/'backend.tar.gz'; path.write_bytes(b'private')
            with self.assertRaisesRegex(ValueError, 'PUBLIC_PACKAGE_UPLOAD_ONLY'):
                aws.put_public_file('fixture', 'bucket', '000000000001', 'installation/'+'a'*64+'/backend.tar.gz', path)
            for service, operation in [('secretsmanager','get-secret-value'), ('ecr','get-authorization-token'), ('kms','sign'), ('ssm','get-parameter')]:
                with self.assertRaises(ValueError): aws.request('fixture', service, operation, {})

    def test_failed_download_checksum_never_executes_the_installer(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d).resolve(); tools = root/'bin'; tools.mkdir()
            marker = root/'INSTALLER_MUST_NOT_RUN'
            scripts = {'aws': '#!/bin/sh\nif [ "$1" = "--version" ]; then echo aws-cli/2.0; exit 0; fi\necho wrong-content > "$4"\n',
                       'sha256sum': '#!/bin/sh\nexit 1\n',
                       'python3': '#!/bin/sh\ntouch '+str(marker)+'\n'}
            for name, data in scripts.items():
                path=tools/name;path.write_text(data);path.chmod(0o755)
            artifact = {'path': 'fixture', 'sha256': 'a'*64}
            value = {'installer': artifact, 'puller': artifact, 'compose': artifact,
                     'roles': {'backend': {'archive': artifact, 'manifest': artifact}}}
            script=workflow.bootstrap('backend','fixture-release-bucket',value)
            # Replace only host-environment preconditions/log location in this
            # workstation test; the download/check/execute shell body is exact.
            script='\n'.join(line for line in script.splitlines() if not line.startswith(('python3 -c', '[ "$(id -u)"')))
            script=script.replace('log=/var/log/', 'log='+str(root)+'/')
            script=script.replace('/var/tmp/kamui-public-install.XXXXXX',str(root/'work.XXXXXX'))
            result=subprocess.run(['sh','-c',script],capture_output=True,text=True,
                env={**os.environ,'PATH':str(tools)+os.pathsep+os.environ['PATH']})
            self.assertNotEqual(result.returncode,0)
            self.assertFalse(marker.exists())
            self.assertIn('KAMUI_PUBLIC_INSTALL_FAILED',result.stdout)

    def test_immutable_uploads_with_same_bytes_different_keys_and_lost_response_do_not_duplicate(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d).resolve(); objects = {}; puts = []; lose = [True]
            def execute(command, **kwargs):
                inputs = json.loads(Path(command[command.index('--cli-input-json')+1].removeprefix('file://')).read_text())
                key = inputs['Key']; operation = command[2]
                if operation == 'head-object':
                    if key not in objects: return subprocess.CompletedProcess(command, 1, b'', b'An error occurred (404) when calling the HeadObject operation')
                    return subprocess.CompletedProcess(command, 0, json.dumps(objects[key]).encode(), b'')
                self.assertEqual(operation, 'put-object'); puts.append(key)
                body = Path(command[command.index('--body')+1]).read_bytes()
                objects[key] = {'ContentLength': len(body), 'ChecksumSHA256': inputs['ChecksumSHA256'], 'Metadata': inputs['Metadata']}
                if lose[0]: lose[0] = False; raise subprocess.TimeoutExpired(command, 1)
                return subprocess.CompletedProcess(command, 0, b'{}', b'')
            aws = common.Aws(root, execute=execute)
            package = root/'installation/package'; package.mkdir(mode=0o700)
            for role in ['backend','pepper']:
                path = package/(role+'.tar.gz'); path.write_bytes(b'same-reviewed-public-bytes')
                key = 'installation/'+common.sha(path.read_bytes())+'/'+path.name
                if role == 'backend':
                    with self.assertRaises(common.AwsError): aws.put_public_file('fixture','fixture-bucket','000000000001',key,path)
                aws.put_public_file('fixture','fixture-bucket','000000000001',key,path)
                aws.put_public_file('fixture','fixture-bucket','000000000001',key,path)
            self.assertEqual(len(puts), 2)


if __name__ == '__main__': unittest.main()


class SupersedeTest(unittest.TestCase):
    def layout(self, directory):
        root = Path(directory).resolve(); installation = root/'installation'
        for path in ['installation', 'installation/release', 'installation/package', 'installation/runtime',
                     'installation/runtime/backend', 'installation/runtime/backend/secrets', 'installation/operations']:
            (root/path).mkdir(mode=0o700)
        common.write_private(installation/'release/release.json', {'sourceRevision': 'c'*40})
        common.write_private(installation/'package/package.json', {'fixture': True})
        for name in workflow.RUNTIME_DERIVED: common.write_private(installation/'runtime'/name, {'derived': name})
        common.write_private(installation/'runtime/backend/secrets/APP_DATABASE_PASSWORD', {'kept': True})
        common.write_private(installation/'operations/backend-release-stack-intent.json', {'kept': True})
        return root, installation

    def test_supersede_archives_release_package_and_derived_runtime_but_keeps_secrets(self):
        with tempfile.TemporaryDirectory() as d:
            root, installation = self.layout(d)
            self.assertEqual(workflow.superseded(root), [])
            result = workflow.supersede(root)
            self.assertEqual(result['superseded'], '001-'+'c'*12)
            archive = installation/'superseded'/result['superseded']
            self.assertFalse((installation/'release').exists()); self.assertFalse((installation/'package').exists())
            self.assertTrue((archive/'release/release.json').exists()); self.assertTrue((archive/'package/package.json').exists())
            for name in workflow.RUNTIME_DERIVED: self.assertFalse((installation/'runtime'/name).exists())
            self.assertTrue((installation/'runtime/backend/secrets/APP_DATABASE_PASSWORD').exists())
            self.assertTrue((installation/'operations/backend-release-stack-intent.json').exists())
            self.assertEqual([r['sourceRevision'] for r in workflow.superseded(root)], ['c'*40])
            with self.assertRaisesRegex(ValueError, 'SUPERSEDE_REQUIRES_COMPLETED_RELEASE'):
                workflow.supersede(root)

    def test_interrupted_supersede_blocks_other_steps_and_resumes(self):
        with tempfile.TemporaryDirectory() as d:
            root, installation = self.layout(d)
            real = os.rename; calls = []
            def crash(source, destination):
                calls.append(source)
                if len(calls) == 2: raise OSError('simulated crash')
                return real(source, destination)
            with patch.object(workflow.os, 'rename', side_effect=crash):
                with self.assertRaises(OSError): workflow.supersede(root)
            with self.assertRaisesRegex(ValueError, 'SUPERSEDE_UNFINISHED_RERUN_SUPERSEDE'):
                workflow.superseded(root)
            self.assertEqual(workflow.supersede(root)['superseded'], '001-'+'c'*12)
            self.assertFalse((installation/'package').exists())
            self.assertEqual(len(workflow.superseded(root)), 1)

    def test_supersede_without_completed_release_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            root, installation = self.layout(d)
            (installation/'release/release.json').unlink()
            with self.assertRaisesRegex(ValueError, 'SUPERSEDE_REQUIRES_COMPLETED_RELEASE'):
                workflow.supersede(root)

    def test_bootstrap_requests_replacement_only_for_install(self):
        artifact = {'path': 'fixture', 'sha256': 'a'*64}
        value = {'installer': artifact, 'puller': artifact, 'compose': artifact,
                 'roles': {'backend': {'archive': artifact, 'manifest': artifact}}}
        self.assertNotIn('--replace-unstarted', workflow.bootstrap('backend', 'fixture-release-bucket', value))
        command = workflow.bootstrap('backend', 'fixture-release-bucket', value, replace=True)
        self.assertIn('--replace-unstarted', command)
        subprocess.run(['sh', '-n'], input=command, text=True, capture_output=True, check=True)
        with self.assertRaisesRegex(ValueError, 'INSTALL_VERIFY_CANNOT_REPLACE'):
            workflow.bootstrap('backend', 'fixture-release-bucket', value, verify=True, replace=True)
