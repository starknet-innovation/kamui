#!/usr/bin/env python3
"""Operator-only immutable release publication. No account/host/application startup.

Run through the numbered installation wrapper. Credentials never enter argv/logs;
ECR push uncertainty is reconciled against immutable tags, never blindly retried.
"""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import uuid

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
SPEC = importlib.util.spec_from_file_location('kamui_setup_release', HERE.parent/'setup/setup_resources.py')
setup = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(setup)
BASES = ('oven/bun:1.4.4', 'oven/bun:1.4.4-slim', 'postgres:16', 'caddy:2-alpine')
IMAGES = ('keychain', 'backend', 'pepper', 'postgres', 'caddy')
KEYS = {name: name.upper()+'_IMAGE' for name in IMAGES}
SHA = re.compile(r'sha256:[0-9a-f]{64}')


def sha(data): return hashlib.sha256(data).hexdigest()


def load(path): return json.loads(setup.read_private(path, limit=2*1024*1024))


def preserve(path, value):
    if path.exists():
        if load(path) != value: raise ValueError('RELEASE_SAVED_STATE_CHANGED')
    else: setup.write_private(path, value)


class Tools:
    def __init__(self, directory): self.directory = setup.private_dir(directory)
    def run(self, args, *, input=None, cwd=None, env=None, timeout=1800, secret_output=False):
        try:
            value = subprocess.run(args, input=input, cwd=cwd, env=env, timeout=timeout, capture_output=True)
        except Exception:
            raise ValueError('RELEASE_TOOL_UNCERTAIN_KEEP_PRIVATE_STATE') from None
        # Login token output and password stdin are never written, even privately.
        if not secret_output:
            identifier = uuid.uuid4().hex
            setup.write_private(self.directory/(identifier+'-operation.json'), {'command': args, 'cwd': str(cwd) if cwd else None, 'returncode': value.returncode})
            for suffix, data in [('stdout',value.stdout), ('stderr',value.stderr)]:
                fd=os.open(self.directory/(identifier+'-'+suffix),os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
                with os.fdopen(fd,'wb') as f: f.write(data); f.flush();os.fsync(f.fileno())
        if value.returncode: raise ValueError('RELEASE_TOOL_FAILED_SEE_PRIVATE_LOGS')
        return value.stdout


def pinned_base(raw, name):
    """Choose one linux/amd64 child; freeze its registry digest, not a moving tag."""
    value=json.loads(raw)
    choices=[m for m in value.get('manifests',[]) if m.get('platform',{}).get('os')=='linux'
             and m.get('platform',{}).get('architecture')=='amd64' and m.get('platform',{}).get('variant') in (None,'')]
    if len(choices)!=1 or not SHA.fullmatch(choices[0].get('digest','')):
        raise ValueError('BASE_AMD64_MANIFEST_REQUIRED')
    return name.split(':')[0]+'@'+choices[0]['digest']


def extract_source(archive, destination):
    """Only committed regular source files; never follow symlinks or archive traversal."""
    with tarfile.open(fileobj=io.BytesIO(archive),mode='r:') as files:
        for member in files:
            relative=Path(member.name)
            if relative.is_absolute() or '..' in relative.parts or '.git' in relative.parts: raise ValueError('SOURCE_ARCHIVE_PATH_REFUSED')
            if member.isdir(): continue
            if not member.isfile(): raise ValueError('SOURCE_ARCHIVE_LINK_REFUSED')
            if relative.name in {'.env','.env.local'} or relative.name.endswith('.private.env'):
                raise ValueError('SOURCE_ARCHIVE_PRIVATE_FILE_REFUSED')
            target=destination/relative; target.parent.mkdir(parents=True,exist_ok=True)
            source=files.extractfile(member)
            if source is None: raise ValueError('SOURCE_ARCHIVE_INVALID')
            with target.open('xb') as output: shutil.copyfileobj(source,output)
            target.chmod(member.mode & 0o777)


def copy_verified_assets(repo, stage):
    manifest=json.loads((stage/'keychain/prover/manifest.json').read_text())
    for name,pin in manifest['files'].items():
        relative=Path(name)
        if relative.is_absolute() or '..' in relative.parts: raise ValueError('PROVER_ASSET_PATH_REFUSED')
        target=stage/'keychain/prover'/relative
        if not target.exists():
            if target.suffix!='.wasm': raise ValueError('UNTRACKED_NONBINARY_ASSET_REFUSED')
            source=repo/'keychain/prover'/relative
            if source.is_symlink() or not source.is_file(): raise ValueError('PINNED_PROVER_ASSET_REQUIRED')
            target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
        if target.is_symlink() or target.stat().st_size!=pin['bytes'] or sha(target.read_bytes())!=pin['sha256']:
            raise ValueError('PINNED_PROVER_ASSET_MISMATCH')


class Release:
    def __init__(self,root,aws,run=None,repo=REPO):
        self.root=setup.private_dir(root);self.directory=setup.private_dir(self.root/'installation')
        self.directory=setup.private_dir(self.directory/'release')
        self.aws=aws;self.repo=Path(repo)
        self.run=run or Tools(setup.private_dir(self.directory/'tool-private')).run

    def identities(self,config):
        for role in ('backend','pepper'):
            v=config[role]
            if not re.fullmatch(r'\d{12}',v['expected_account']):raise ValueError('RELEASE_EXPECTED_ACCOUNT_REQUIRED')
            if self.aws.request(v['aws_profile'],'sts','get-caller-identity',{}).get('Account')!=v['expected_account']:
                raise ValueError('RELEASE_ACCOUNT_MISMATCH')
        if config['backend']['expected_account']==config['pepper']['expected_account']:raise ValueError('RELEASE_DISTINCT_ACCOUNTS_REQUIRED')

    def source_revision(self):
        if self.run(['git','status','--porcelain','--untracked-files=all'],cwd=self.repo).strip():
            raise ValueError('RELEASE_COMMITTED_CLEAN_SOURCE_REQUIRED')
        revision=self.run(['git','rev-parse','HEAD'],cwd=self.repo).decode().strip()
        if not re.fullmatch('[0-9a-f]{40}',revision):raise ValueError('RELEASE_SOURCE_REVISION_INVALID')
        return revision

    def prepare_resources(self,stack_callback):
        config=load(self.root/'aws-input.json');self.identities(config)
        revision=self.source_revision()
        template=json.loads((HERE/'release-resources.json').read_text())
        roles={}
        for role in ('backend','pepper'):
            values=config[role]
            reply=self.aws.request(values['aws_profile'],'iam','get-instance-profile',{'InstanceProfileName':values['instance_profile_name']})
            entries=reply.get('InstanceProfile',{}).get('Roles',[])
            if len(entries)!=1:raise ValueError('RELEASE_HOST_ROLE_REQUIRED')
            item=entries[0]
            if not re.fullmatch(r'[A-Za-z0-9+=,.@_-]{1,64}',item.get('RoleName','')) or not re.fullmatch(r'arn:aws:iam::'+values['expected_account']+r':role/[A-Za-z0-9+=,.@_/-]+',item.get('Arn','')):
                raise ValueError('RELEASE_HOST_ROLE_INVALID')
            roles[role]=item
        parameters={'HostRole':'backend','HostRoleName':roles['backend']['RoleName'],'BackendAccount':config['backend']['expected_account'],
                    'PepperRoleArn':roles['pepper']['Arn'],'ReleaseBucketArn':'arn:aws:s3:::kamui-unused-backend-placeholder'}
        backend=stack_callback('backend','release',template,parameters)
        if not re.fullmatch(r'arn:aws:s3:::[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]',backend.get('ReleaseBucketArn','')):
            raise ValueError('RELEASE_ARTIFACT_BUCKET_INVALID')
        pepper=stack_callback('pepper','release',template,{**parameters,'HostRole':'pepper','HostRoleName':roles['pepper']['RoleName'],'ReleaseBucketArn':backend['ReleaseBucketArn']})
        registry=config['backend']['expected_account']+'.dkr.ecr.eu-west-1.amazonaws.com'
        if backend.get('ReleaseRegistry')!=registry or pepper.get('ReleaseRegistry')!=registry:raise ValueError('RELEASE_REGISTRY_MISMATCH')
        for name in IMAGES:
            if backend.get(name.title()+'RepositoryUri')!=registry+'/kamui-sepolia/'+name:raise ValueError('RELEASE_REPOSITORY_MISMATCH')
        preserve(self.directory/'resources.json',{'schema':'kamui.release-resources.v1','sourceRevision':revision,'config':config,'backend':backend,'pepper':pepper})
        return backend

    def plan(self):
        resources=load(self.directory/'resources.json');self.identities(resources['config'])
        if self.source_revision()!=resources['sourceRevision']:raise ValueError('RELEASE_SOURCE_CHANGED')
        path=self.directory/'plan.json'
        if path.exists():
            plan=load(path)
            if plan['sourceRevision']!=resources['sourceRevision']:raise ValueError('RELEASE_SOURCE_CHANGED')
            return resources,plan
        pins={name:pinned_base(self.run(['docker','buildx','imagetools','inspect','--raw',name]),name) for name in BASES}
        plan={'schema':'kamui.release-build.v1','runId':uuid.uuid4().hex,'sourceRevision':resources['sourceRevision'],'baseImages':pins}
        setup.write_private(path,plan);return resources,plan

    def image(self,resources,name,tag):
        account=resources['config']['backend']['expected_account'];profile=resources['config']['backend']['aws_profile']
        request={'registryId':account,'repositoryName':'kamui-sepolia/'+name,'imageIds':[{'imageTag':tag}]}
        try:value=self.aws.request(profile,'ecr','describe-images',request)
        except Exception as error:
            if getattr(error,'code',None) in {'ImageNotFoundException','ECR_IMAGE_NOT_FOUND'}:return None
            raise
        images=value.get('imageDetails',[])
        if len(images)!=1 or tag not in images[0].get('imageTags',[]) or not SHA.fullmatch(images[0].get('imageDigest','')):
            raise ValueError('RELEASE_IMAGE_OBSERVATION_INVALID')
        batch=self.aws.request(profile,'ecr','batch-get-image',request)
        manifests=batch.get('images',[])
        if len(manifests)!=1:raise ValueError('RELEASE_IMAGE_MANIFEST_REQUIRED')
        manifest=json.loads(manifests[0]['imageManifest'])
        if sha(manifests[0]['imageManifest'].encode())!=images[0]['imageDigest'].removeprefix('sha256:'):
            raise ValueError('RELEASE_IMAGE_MANIFEST_MISMATCH')
        return {'digest':images[0]['imageDigest'],'configDigest':manifest.get('config',{}).get('digest')}

    def build_publish(self):
        resources,plan=self.plan()
        final=self.directory/'release.json'
        if final.exists():
            result=load(final)
            if result['sourceRevision']!=plan['sourceRevision']:raise ValueError('RELEASE_SOURCE_CHANGED')
            return result
        stage=self.directory/'source'
        if not stage.exists():
            temp=Path(tempfile.mkdtemp(prefix='.source-',dir=self.directory))
            try:
                extract_source(self.run(['git','archive','--format=tar',plan['sourceRevision']],cwd=self.repo),temp)
                copy_verified_assets(self.repo,temp)
                replacements={
                  'keychain/Dockerfile':{'oven/bun:1.4.4-slim':plan['baseImages']['oven/bun:1.4.4-slim']},
                  'services/backend/src/services/api/Dockerfile':{'oven/bun:1.4.4':plan['baseImages']['oven/bun:1.4.4']},
                  'services/pepper/Dockerfile':{'oven/bun:1.4.4-slim':plan['baseImages']['oven/bun:1.4.4-slim']},
                  'infra/aws/lean/backup/Dockerfile':{'postgres:16':plan['baseImages']['postgres:16']}}
                for relative,pins in replacements.items():
                    file=temp/relative;data=file.read_text()
                    for original,pin in pins.items():data=data.replace(original,pin)
                    file.write_text(data)
                os.rename(temp,stage)
            finally:
                if temp.exists():shutil.rmtree(temp)
        contexts={'keychain':(stage,stage/'keychain/Dockerfile'), 'backend':(stage/'services/backend',stage/'services/backend/src/services/api/Dockerfile'),
                  'pepper':(stage/'services/pepper',stage/'services/pepper/Dockerfile'),'postgres':(stage/'infra/aws/lean/backup',stage/'infra/aws/lean/backup/Dockerfile')}
        images={};tag='release-'+plan['sourceRevision'][:12]+'-'+plan['runId'][:12]
        main_sha=None
        with tempfile.TemporaryDirectory(prefix='.docker-auth-',dir=self.directory) as auth:
            env={**setup.environment(),'DOCKER_CONFIG':auth}
            profile=resources['config']['backend']['aws_profile'];registry=resources['backend']['ReleaseRegistry']
            password=self.run(['aws','ecr','get-login-password','--profile',profile,'--region','eu-west-1','--no-cli-pager'],env=setup.environment(),secret_output=True,timeout=50)
            self.run(['docker','login','--username','AWS','--password-stdin',registry],input=password,env=env,secret_output=True,timeout=60)
            for name in IMAGES:
                target=resources['backend'][name.title()+'RepositoryUri']+':'+tag
                intent=self.directory/(name+'-push-intent.json')
                built=self.directory/(name+'-built.json')
                if built.exists():
                    local=load(built)
                else:
                    print('BUILDING_'+name.upper()+'_IMAGE',flush=True)
                    if intent.exists():raise ValueError('RELEASE_BUILD_STATE_MISSING_KEEP_INTENT')
                    if name=='caddy':
                        self.run(['docker','pull','--platform','linux/amd64',plan['baseImages']['caddy:2-alpine']])
                        self.run(['docker','tag',plan['baseImages']['caddy:2-alpine'],target])
                    else:
                        context,dockerfile=contexts[name]
                        self.run(['docker','build','--platform','linux/amd64','--file',str(dockerfile),'--tag',target,str(context)])
                    raw=self.run(['docker','image','inspect','--format','{{.Id}}',target]).decode().strip()
                    if not SHA.fullmatch(raw):raise ValueError('RELEASE_LOCAL_IMAGE_INVALID')
                    local={'image':target,'configDigest':raw}
                    if name=='keychain':
                        main=self.run(['docker','run','--rm','--network','none','--entrypoint','bun',target,'-e',"process.stdout.write(await Bun.file('/app/dist/main.js').text())"])
                        local['mainJsSha256']=sha(main)
                    setup.write_private(built,local)
                observed=self.image(resources,name,tag)
                if intent.exists():
                    if load(intent)!=local:raise ValueError('RELEASE_PUSH_INTENT_CHANGED')
                    if observed is None:raise ValueError('RELEASE_PUSH_UNCERTAIN_RECONCILE_ONLY')
                else:
                    if observed is not None:raise ValueError('RELEASE_TAG_COLLISION')
                    setup.write_private(intent,local)
                    print('PUBLISHING_'+name.upper()+'_IMAGE',flush=True)
                    self.run(['docker','push',target],env=env)
                    observed=self.image(resources,name,tag)
                if observed is None or observed['configDigest']!=local['configDigest']:
                    raise ValueError('RELEASE_REMOTE_IMAGE_MISMATCH')
                images[KEYS[name]]=resources['backend'][name.title()+'RepositoryUri']+'@'+observed['digest']
                if name=='keychain':main_sha=local['mainJsSha256']
        manifest={'schema':'kamui.release.v1','sourceRevision':plan['sourceRevision'],'sourceCommit':plan['sourceRevision'],'baseImages':plan['baseImages'],
                  'images':images,'mainJsSha256':main_sha,'architecture':'linux/amd64','requiresVulnerabilityAndLicenseReview':True,
                  'releaseBucketName':resources['backend']['ReleaseBucketName'],'releaseBucketArn':resources['backend']['ReleaseBucketArn']}
        content=''.join(k+'='+images[k]+'\n' for k in sorted(images))
        env_path=self.directory/'release.env'
        if env_path.exists():
            if setup.read_private(env_path).decode()!=content:raise ValueError('RELEASE_ENV_CHANGED')
        else:
            fd=os.open(env_path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'w') as out:out.write(content);out.flush();os.fsync(out.fileno())
            setup.sync(self.directory)
        setup.write_private(final,manifest)
        print('IMMUTABLE_RELEASE_PUBLISHED_NOT_INSTALLED')
        return manifest
