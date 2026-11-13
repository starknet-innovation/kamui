"""Release transport/build fault tests. No AWS, Docker daemon or credential reads."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('release_tested',HERE/'release.py')
release=importlib.util.module_from_spec(spec);spec.loader.exec_module(release)


def archive(files):
    data=io.BytesIO()
    with tarfile.open(fileobj=data,mode='w') as output:
        for name,body in files.items():
            body=body.encode() if isinstance(body,str) else body
            member=tarfile.TarInfo(name);member.size=len(body);member.mode=0o644
            output.addfile(member,io.BytesIO(body))
    return data.getvalue()


class Error(Exception):
    code='ImageNotFoundException'


class Fake:
    def __init__(self):
        self.calls=[];self.tools=[];self.remote={};self.pushes=[];self.lose=False;self.omit=False
        self.accounts={'backend-profile':'000000000001','pepper-profile':'000000000002'}
        self.head=b'a'*40;self.changed=[];self.ancestor=True;self.dirty=[];self.descriptors={}
        self.files={'keychain/Dockerfile':'FROM oven/bun:1.4.4-slim\n',
            'services/backend/src/services/api/Dockerfile':'FROM oven/bun:1.4.4\n',
            'services/pepper/Dockerfile':'FROM oven/bun:1.4.4-slim\n',
            'infra/aws/lean/backup/Dockerfile':'ARG POSTGRES_IMAGE=postgres:16\nFROM ${POSTGRES_IMAGE}\n',
            'keychain/prover/manifest.json':json.dumps({'files':{}})}
    def request(self,profile,service,operation,inputs):
        self.calls.append((profile,service,operation,copy.deepcopy(inputs)))
        if operation=='get-caller-identity':return {'Account':self.accounts[profile]}
        if operation=='get-instance-profile':
            return {'InstanceProfile':{'Roles':[{'RoleName':profile+'-host','Arn':'arn:aws:iam::'+self.accounts[profile]+':role/host'}]}}
        name=inputs['repositoryName'].split('/')[-1]
        if name not in self.remote:raise Error()
        item=self.remote[name]
        if operation=='describe-images':return {'imageDetails':[{'imageTags':[inputs['imageIds'][0]['imageTag']],'imageDigest':item['digest']}]}
        if operation=='batch-get-image':
            requested=inputs['imageIds'][0].get('imageDigest')
            if requested:return {'images':[{'imageManifest':item.get('children',{}).get(requested,'{}')}]}
            return {'images':[{'imageManifest':item['manifest']}]}
        raise AssertionError('unexpected operation')
    def run(self,args,**kwargs):
        self.tools.append((args,kwargs))
        if args[:3]==['git','status','--porcelain']:return b'M helpers' if self.dirty else b''
        if args[:3]==['git','rev-parse','HEAD']:return self.head+b'\n'
        if args[:3]==['git','merge-base','--is-ancestor']:
            if not self.ancestor:raise ValueError('NOT_ANCESTOR')
            return b''
        if args[:3]==['git','diff','--name-only']:return b'\0'.join(p.encode() for p in (self.dirty if args[-1]=='HEAD' else self.changed))
        if args[:3]==['git','ls-files','--others']:return b''
        if args[:2]==['git','archive']:return archive(self.files)
        if args[:4]==['docker','buildx','imagetools','inspect']:
            return json.dumps({'manifests':[{'platform':{'os':'linux','architecture':'amd64'},'digest':'sha256:'+release.sha(args[-1].encode())}]}).encode()
        if args[:3]==['aws','ecr','get-login-password']:
            if not kwargs.get('secret_output'):raise AssertionError('token output must not be logged')
            return b'fake-password'
        if args[:2]==['docker','login']:
            if kwargs.get('input')!=b'fake-password' or not kwargs.get('secret_output'):raise AssertionError('private stdin login required')
            return b''
        if args[:3]==['docker','image','inspect']:
            name=args[-1].split('/')[-1].split(':')[0]
            if args[args.index('--format')+1]=='{{json .}}':return json.dumps(self.descriptors[name]).encode()
            return ('sha256:'+release.sha(name.encode())).encode()
        if args[:2]==['docker','run']:return b'public-main-js'
        if args[:2]==['docker','push']:
            name=args[-1].split('/')[-1].split(':')[0];self.pushes.append(name)
            if not self.omit:
                manifest=json.dumps({'schemaVersion':2,'config':{'digest':'sha256:'+release.sha(name.encode())},'layers':[]})
                self.remote[name]={'manifest':manifest,'digest':'sha256:'+release.sha(manifest.encode())}
            if self.lose:
                self.lose=False;raise ValueError('PUSH_RESPONSE_LOST')
            return b''
        if args[:2] in (['docker','build'],['docker','pull'],['docker','tag']):return b''
        raise AssertionError('unexpected tool')


class ReleaseTest(unittest.TestCase):
    def fixture(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        root=Path(temp.name).resolve();root.chmod(0o700)
        config={'backend':{'aws_profile':'backend-profile','expected_account':'000000000001','instance_profile_name':'backend-host'},
                'pepper':{'aws_profile':'pepper-profile','expected_account':'000000000002','instance_profile_name':'pepper-host'}}
        release.setup.write_private(root/'aws-input.json',config)
        fake=Fake();instance=release.Release(root,fake,run=fake.run,repo=root)
        callbacks=[]
        def stack(role,kind,template,parameters):
            callbacks.append((role,kind,template,parameters))
            registry='000000000001.dkr.ecr.eu-west-1.amazonaws.com'
            if role=='pepper':return {'ReleaseRegistry':registry}
            return {'ReleaseRegistry':registry,'ReleaseBucketArn':'arn:aws:s3:::fixture-release-code','ReleaseBucketName':'fixture-release-code',
                    **{name.title()+'RepositoryUri':registry+'/kamui-sepolia/'+name for name in release.IMAGES}}
        return root,fake,instance,stack,callbacks
    def test_publish_exact_images_with_pinned_bases_main_hash_and_ephemeral_credentials(self):
        root,fake,item,stack,calls=self.fixture()
        item.prepare_resources(stack);result=item.build_publish()
        self.assertEqual([c[0] for c in calls],['backend','pepper'])
        self.assertEqual(result['mainJsSha256'],release.sha(b'public-main-js'))
        self.assertEqual(set(result['images']),set(release.KEYS.values()))
        self.assertTrue(all('@sha256:' in value for value in result['images'].values()))
        self.assertEqual(fake.pushes,list(release.IMAGES))
        self.assertFalse(list(item.directory.glob('.docker-auth-*')))
        self.assertNotIn('fake-password',json.dumps([args for args,_ in fake.tools]))
        self.assertIn('@sha256:',(item.directory/'source/keychain/Dockerfile').read_text())
        self.assertEqual((item.directory/'release.env').stat().st_mode&0o777,0o600)
        item.build_publish();self.assertEqual(fake.pushes,list(release.IMAGES))
    def test_lost_push_response_reconciles_remote_digest_without_repush(self):
        _,fake,item,stack,_=self.fixture();item.prepare_resources(stack);fake.lose=True
        with self.assertRaisesRegex(ValueError,'PUSH_RESPONSE_LOST'):item.build_publish()
        result=item.build_publish()
        self.assertEqual(fake.pushes,list(release.IMAGES))
        self.assertTrue(result['images']['KEYCHAIN_IMAGE'].endswith(fake.remote['keychain']['digest']))
    def test_unseen_uncertain_push_is_not_retried(self):
        _,fake,item,stack,_=self.fixture();item.prepare_resources(stack);fake.lose=True;fake.omit=True
        with self.assertRaisesRegex(ValueError,'PUSH_RESPONSE_LOST'):item.build_publish()
        with self.assertRaisesRegex(ValueError,'RELEASE_PUSH_UNCERTAIN_RECONCILE_ONLY'):item.build_publish()
        self.assertEqual(fake.pushes,['keychain'])

    def indexed(self,fake):
        item=fake.remote['keychain'];child=item['manifest'];child_digest=item['digest']
        value={'schemaVersion':2,'mediaType':'application/vnd.oci.image.index.v1+json','manifests':[
            {'digest':child_digest,'platform':{'os':'linux','architecture':'amd64'}},
            {'digest':'sha256:'+'f'*64,'platform':{'os':'unknown','architecture':'unknown'}}]}
        raw=json.dumps(value)
        fake.remote['keychain']={'manifest':raw,'digest':'sha256:'+release.sha(raw.encode()),'children':{child_digest:child}}
        return value,child_digest

    def test_pushed_oci_index_binds_amd64_config_and_resumes_without_repush(self):
        _,fake,item,stack,_=self.fixture();item.prepare_resources(stack);fake.lose=True
        with self.assertRaises(ValueError):item.build_publish()
        self.indexed(fake)
        # The tool fixes are committed descendants; the app build stays frozen.
        fake.head=b'b'*40;fake.changed=['infra/aws/lean/install/release.py','PLAN.md']
        item.prepare_resources(stack);result=item.build_publish()
        self.assertEqual(result['sourceRevision'],'a'*40)
        self.assertTrue(result['images']['KEYCHAIN_IMAGE'].endswith(fake.remote['keychain']['digest']))
        self.assertEqual(fake.pushes,list(release.IMAGES))
        self.assertTrue(any('imageDigest' in c[3].get('imageIds',[{}])[0] for c in fake.calls if c[2]=='batch-get-image'))

    def test_index_child_hash_mismatch_and_duplicate_amd64_are_refused(self):
        for failure in ['hash','duplicate']:
            _,fake,item,stack,_=self.fixture();item.prepare_resources(stack);fake.lose=True
            with self.assertRaises(ValueError):item.build_publish()
            value,child=self.indexed(fake)
            if failure=='hash':fake.remote['keychain']['children'][child]='{}'
            else:
                value['manifests'].append(value['manifests'][0]);raw=json.dumps(value)
                fake.remote['keychain'].update(manifest=raw,digest='sha256:'+release.sha(raw.encode()))
            with self.assertRaisesRegex(ValueError,'RELEASE_IMAGE_MANIFEST_MISMATCH' if failure=='hash' else 'RELEASE_UNIQUE_AMD64_IMAGE_REQUIRED'):
                item.build_publish()
            self.assertEqual(fake.pushes,['keychain'])

    def test_legacy_docker_index_id_is_verified_without_rewriting_or_repush(self):
        root,fake,item,stack,_=self.fixture();item.prepare_resources(stack);fake.lose=True
        with self.assertRaises(ValueError):item.build_publish()
        self.indexed(fake);digest=fake.remote['keychain']['digest']
        built=json.loads((item.directory/'keychain-built.json').read_text())
        built.pop('imageId');built['configDigest']=digest  # Historical field held Docker's index ID.
        for suffix in ['built','push-intent']:(item.directory/('keychain-'+suffix+'.json')).write_text(json.dumps(built))
        before=(item.directory/'keychain-push-intent.json').read_bytes()
        fake.descriptors['keychain']={'Id':digest,'Descriptor':{'digest':digest,'mediaType':'application/vnd.oci.image.index.v1+json'},'Os':'linux','Architecture':'amd64'}
        result=item.build_publish()
        self.assertTrue(result['images']['KEYCHAIN_IMAGE'].endswith(digest))
        self.assertEqual(fake.pushes,list(release.IMAGES))
        self.assertEqual((item.directory/'keychain-push-intent.json').read_bytes(),before)
        self.assertEqual(json.loads((item.directory/'keychain-identity-verified.json').read_text())['identityKind'],'descriptor')

    def test_wrong_local_descriptor_cannot_mask_config_mismatch(self):
        _,fake,item,stack,_=self.fixture();item.prepare_resources(stack);fake.lose=True
        with self.assertRaises(ValueError):item.build_publish()
        self.indexed(fake);digest=fake.remote['keychain']['digest']
        built=json.loads((item.directory/'keychain-built.json').read_text());built['imageId']=digest
        for suffix in ['built','push-intent']:(item.directory/('keychain-'+suffix+'.json')).write_text(json.dumps(built))
        fake.descriptors['keychain']={'Id':digest,'Descriptor':{'digest':digest,'mediaType':'application/vnd.oci.image.index.v1+json'},'Os':'linux','Architecture':'arm64'}
        with self.assertRaisesRegex(ValueError,'RELEASE_LOCAL_DESCRIPTOR_MISMATCH'):item.build_publish()
        self.assertEqual(fake.pushes,['keychain'])

    def test_local_helper_exception_is_explicit_existing_release_only_and_logged(self):
        root,fake,item,stack,_=self.fixture();item.prepare_resources(stack)
        file=root/'infra/aws/lean/install/release.py';file.parent.mkdir(parents=True);file.write_text('reviewed helper fix')
        fake.dirty=['infra/aws/lean/install/release.py']
        with self.assertRaisesRegex(ValueError,'RELEASE_COMMITTED_CLEAN_SOURCE_REQUIRED'):item.plan()
        item.allow_local_tools=True
        item.plan()
        records=list(item.directory.glob('local-tool-fixes-*.json'))
        self.assertEqual(len(records),1)
        self.assertEqual(json.loads(records[0].read_text())['files'][fake.dirty[0]],release.sha(file.read_bytes()))
        fake.dirty=['services/backend/src/index.ts']
        with self.assertRaisesRegex(ValueError,'LOCAL_TOOL_FIXES_APPLICATION_CHANGE_REFUSED'):item.plan()

    def test_local_helper_exception_cannot_start_a_new_release(self):
        _,fake,item,stack,callbacks=self.fixture();item.allow_local_tools=True
        fake.dirty=['infra/aws/lean/install/release.py']
        with self.assertRaisesRegex(ValueError,'LOCAL_TOOL_FIXES_EXISTING_RELEASE_ONLY'):item.prepare_resources(stack)
        self.assertEqual(callbacks,[]);self.assertEqual(fake.pushes,[])

    def test_app_changes_or_unrelated_history_cannot_resume_frozen_release(self):
        for changed,ancestor in [(['keychain/src/main.ts'],True),(['infra/aws/lean/backup/Dockerfile'],True),(['infra/aws/lean/install/release.py'],False)]:
            _,fake,item,stack,_=self.fixture();item.prepare_resources(stack)
            fake.head=b'b'*40;fake.changed=changed;fake.ancestor=ancestor
            with self.assertRaisesRegex(ValueError,'RELEASE_APPLICATION_SOURCE_CHANGED' if ancestor else 'RELEASE_SOURCE_NOT_ANCESTOR'):
                item.build_publish()
            self.assertEqual(fake.pushes,[])
    def test_account_mismatch_prevents_cloudformation_or_build(self):
        _,fake,item,stack,calls=self.fixture();fake.accounts['pepper-profile']='000000000003'
        with self.assertRaisesRegex(ValueError,'RELEASE_ACCOUNT_MISMATCH'):item.prepare_resources(stack)
        self.assertEqual(calls,[]);self.assertEqual(fake.tools,[])
    def test_committed_archive_cannot_include_private_file_or_symlink(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(ValueError,'SOURCE_ARCHIVE_PRIVATE_FILE_REFUSED'):
                release.extract_source(archive({'.env.local':'PRIVATE_SENTINEL'}),Path(d))
            b=io.BytesIO()
            with tarfile.open(fileobj=b,mode='w') as t:
                m=tarfile.TarInfo('keychain/link');m.type=tarfile.SYMTYPE;m.linkname='/private';t.addfile(m)
            with self.assertRaisesRegex(ValueError,'SOURCE_ARCHIVE_LINK_REFUSED'):release.extract_source(b.getvalue(),Path(d))
    def test_base_pin_requires_unique_linux_amd64_manifest(self):
        for data in [{}, {'manifests':[{'platform':{'os':'linux','architecture':'arm64'},'digest':'sha256:'+'0'*64}]}]:
            with self.assertRaisesRegex(ValueError,'BASE_AMD64_MANIFEST_REQUIRED'):release.pinned_base(json.dumps(data),'source:tag')
    def test_real_tool_transport_never_records_login_output_or_stdin(self):
        import subprocess
        with tempfile.TemporaryDirectory() as d:
            root=Path(d).resolve();root.chmod(0o700)
            tools=release.Tools(root)
            answer=subprocess.CompletedProcess(['fake'],0,b'PRIVATE_TOKEN_SENTINEL',b'PRIVATE_TOKEN_SENTINEL')
            with patch.object(release.subprocess,'run',return_value=answer):
                self.assertEqual(tools.run(['aws','ecr','get-login-password'],secret_output=True),b'PRIVATE_TOKEN_SENTINEL')
                tools.run(['docker','login'],input=b'PRIVATE_TOKEN_SENTINEL',secret_output=True)
            self.assertEqual(list(root.iterdir()),[])
    def test_only_manifest_verified_wasm_can_be_added_from_untracked_worktree(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);repo=root/'repo';stage=root/'stage'
            for base in [repo,stage]:(base/'keychain/prover').mkdir(parents=True)
            binary=b'public-wasm-fixture'
            manifest={'files':{'binary.wasm':{'bytes':len(binary),'sha256':release.sha(binary)}}}
            (stage/'keychain/prover/manifest.json').write_text(json.dumps(manifest))
            (repo/'keychain/prover/binary.wasm').write_bytes(binary)
            release.copy_verified_assets(repo,stage)
            self.assertEqual((stage/'keychain/prover/binary.wasm').read_bytes(),binary)
            (stage/'keychain/prover/binary.wasm').write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError,'PINNED_PROVER_ASSET_MISMATCH'):release.copy_verified_assets(repo,stage)
            manifest={'files':{'not-tracked.mjs':{'bytes':0,'sha256':release.sha(b'')}}}
            (stage/'keychain/prover/manifest.json').write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError,'UNTRACKED_NONBINARY_ASSET_REFUSED'):release.copy_verified_assets(repo,stage)
    def test_template_has_immutable_repos_and_only_pull_permissions(self):
        t=json.loads((HERE/'release-resources.json').read_text())
        repos=[v for v in t['Resources'].values() if v['Type']=='AWS::ECR::Repository']
        self.assertEqual(len(repos),5)
        for resource in repos:
            self.assertEqual(resource['Properties']['ImageTagMutability'],'IMMUTABLE')
            self.assertEqual(resource['DeletionPolicy'],'Retain')
        policy=t['Resources']['HostImagePullPolicy']['Properties']['PolicyDocument']
        self.assertNotIn('ecr:PutImage',json.dumps(policy));self.assertNotIn('kms:',json.dumps(policy))
        self.assertIn('s3:GetObject',json.dumps(policy));self.assertNotIn('s3:PutObject',json.dumps(policy))
        bucket=t['Resources']['ReleaseBucket'];self.assertEqual(bucket['DeletionPolicy'],'Retain')
        self.assertEqual(bucket['Properties']['VersioningConfiguration']['Status'],'Enabled')
        self.assertTrue(all(bucket['Properties']['PublicAccessBlockConfiguration'].values()))


if __name__=='__main__':unittest.main()


class InfrastructureOnlyTest(unittest.TestCase):
    def test_lean_documentation_is_infrastructure_but_package_and_app_files_are_not(self):
        accepted = ['infra/aws/lean/backup/README.md', 'infra/aws/lean/install/REBOOT.md', 'infra/aws/lean/README.md',
                    'infra/aws/lean/install/runtime.py', 'infra/aws/lean/setup/14-reopen-after-reboot.sh']
        refused = ['keychain/README.md', 'services/backend/README.md', 'infra/aws/lean/backup/backup.sh',
                   'infra/aws/lean/systemd/kamui@.service', 'infra/aws/lean/backend/compose.yml', 'infra/aws/terraform/README.md']
        for path in accepted: self.assertTrue(release.infrastructure_only([path]), path)
        for path in refused: self.assertFalse(release.infrastructure_only([path]), path)
        # The rule is only sound while no Markdown file is shipped in the host package.
        spec = importlib.util.spec_from_file_location('install_files', HERE/'install.py')
        install = importlib.util.module_from_spec(spec); spec.loader.exec_module(install)
        self.assertFalse(any(name.endswith('.md') for name in install.FILES))

    def test_ci_and_keychain_test_files_are_infrastructure_because_no_image_copies_them(self):
        for path in ['.github/workflows/keychain-tests.yml', 'keychain/tests/keychain.spec.ts', 'keychain/playwright.config.ts']:
            self.assertTrue(release.infrastructure_only([path]), path)
        for path in ['keychain/src/main.ts', 'keychain/server.ts', 'keychain/prover/manifest.json', 'keychain/scripts/prover-assets.ts', 'keychain/package.json']:
            self.assertFalse(release.infrastructure_only([path]), path)
        import re
        copied = []
        for line in (HERE.parents[3]/'keychain/Dockerfile').read_text().splitlines():
            if line.startswith('COPY') and '--from=' not in line: copied += line.split()[1:-1]
        self.assertTrue(copied)
        for source in copied:
            self.assertFalse(source.startswith(('keychain/tests', '.github')) or source in {'keychain', '.', 'keychain/', 'keychain/playwright.config.ts'}, source)
