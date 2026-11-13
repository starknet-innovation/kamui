import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('image_pull_test',Path(__file__).with_name('image_pull.py'))
images=importlib.util.module_from_spec(spec);spec.loader.exec_module(images)


class ImagePullTest(unittest.TestCase):
    def fixture(self,root,role='backend'):
        values={key:'000000000001.dkr.ecr.eu-west-1.amazonaws.com/kamui-sepolia/'+name+'@sha256:'+'a'*64
            for key,name in [('CADDY_IMAGE','caddy'),('KEYCHAIN_IMAGE','keychain'),('BACKEND_IMAGE','backend'),('POSTGRES_IMAGE','postgres'),('PEPPER_IMAGE','pepper')]}
        path=root/'manifest.json';raw=json.dumps({'schema':'kamui.host-install.v1','role':role,'releaseImages':values}).encode();path.write_bytes(raw)
        return path,hashlib.sha256(raw).hexdigest()

    def test_tokens_stay_in_stdin_and_temporary_config_is_removed(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d).resolve();path,digest=self.fixture(root);calls=[];configs=[]
            def execute(args,**kwargs):
                calls.append(args);auth=Path(kwargs['env']['DOCKER_CONFIG']);configs.append(auth)
                self.assertNotIn('PRIVATE_TOKEN',str(args))
                if args[0]=='aws':return subprocess.CompletedProcess(args,0,b'PRIVATE_TOKEN',b'')
                if 'login' in args:
                    self.assertEqual(kwargs['input'],b'PRIVATE_TOKEN');(auth/'config.json').write_bytes(b'PRIVATE_TOKEN')
                body=json.dumps([args[-1]]).encode() if 'inspect' in args else b''
                return subprocess.CompletedProcess(args,0,body,b'')
            result=images.run_images('backend',path,digest,root/'auth',execute=execute)
            self.assertEqual(result['imagesVerified'],4)
            self.assertTrue(all(not p.exists() for p in configs))
            self.assertFalse(any('run' in args for args in calls))

    def test_verify_never_authenticates_pulls_or_starts_containers(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d).resolve();path,digest=self.fixture(root,'pepper');calls=[]
            def execute(args,**kwargs):
                calls.append(args)
                self.assertIn('inspect',args)
                return subprocess.CompletedProcess(args,0,json.dumps([args[-1]]).encode(),b'')
            self.assertEqual(images.run_images('pepper',path,digest,root/'auth',verify=True,execute=execute)['imagesVerified'],2)
            self.assertEqual(len(calls),2)

    def test_changed_manifest_or_local_digest_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d).resolve();path,digest=self.fixture(root)
            with self.assertRaisesRegex(ValueError,'IMAGE_MANIFEST_CHANGED'):
                images.run_images('backend',path,'b'*64,root/'auth')
            with self.assertRaisesRegex(ValueError,'IMAGE_LOCAL_DIGEST_MISMATCH'):
                images.run_images('backend',path,digest,root/'auth',verify=True,
                    execute=lambda args,**kwargs:subprocess.CompletedProcess(args,0,b'[]',b''))
