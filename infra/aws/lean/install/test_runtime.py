"""Offline runtime preparation. Synthetic metadata only; no AWS or secret delivery."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('runtime_config', HERE/'runtime.py')
runtime = importlib.util.module_from_spec(spec); spec.loader.exec_module(runtime)


def metadata():
    key = 'arn:aws:kms:eu-west-1:000000000002:key/11111111-1111-1111-1111-111111111111'
    return {'googleClientId': '123-test.apps.googleusercontent.com', 'relayerAddress': '0x123',
            'classHash': runtime.CLASS, 'registryAddress': runtime.REGISTRY, 'registryBlock': '18030487',
            'executorAddress': runtime.EXECUTOR, 'pepperKeyArn': key, 'selectedPepperKeyArn': key,
            'pepperKeyCheck': '1234567890abcdef', 'pepperAudiences': '123-test.apps.googleusercontent.com',
            'backupBucket': 'kamui-backup-fixture'}


class RuntimeTests(unittest.TestCase):
    def fixture(self):
        d = tempfile.TemporaryDirectory(); self.addCleanup(d.cleanup)
        root = Path(d.name).resolve();root.chmod(0o700)
        return root

    def test_prepare_is_private_idempotent_and_never_startup_ready(self):
        root = self.fixture()
        first = runtime.prepare(root, metadata())
        target = root/'installation/runtime'
        passwords = {name: (target/'backend/secrets'/name).read_bytes() for name in ['POSTGRES_PASSWORD','APP_DATABASE_PASSWORD']}
        second = runtime.prepare(root, metadata())
        self.assertEqual(first, second)
        self.assertFalse(first['startupReady']);self.assertFalse(first['servicesStarted'])
        self.assertTrue(first['externalRelayerSourcePending'])
        for name,value in passwords.items():
            self.assertEqual((target/'backend/secrets'/name).read_bytes(), value)
            self.assertEqual((target/'backend/secrets'/name).stat().st_mode & 0o777, 0o600)
        self.assertNotEqual(*passwords.values())
        self.assertEqual((target/'backend/secrets/DATABASE_URL').read_bytes(), (target/'backend/secrets/OPERATOR_DATABASE_URL').read_bytes())
        self.assertIn(passwords['APP_DATABASE_PASSWORD'].strip(), (target/'backend/secrets/DATABASE_URL').read_bytes())
        self.assertNotIn(passwords['APP_DATABASE_PASSWORD'].decode().strip(), json.dumps(first))

    def test_manifest_never_includes_existing_key_and_has_scoped_target_ownership(self):
        root = self.fixture();runtime.prepare(root, metadata())
        manifest=json.loads((root/'installation/runtime/manifest.json').read_text())
        self.assertFalse(manifest['publicPackageAllowed']);self.assertFalse(manifest['automaticSecretUploadAllowed'])
        entries={row['path']: row for row in manifest['entries']}
        self.assertNotIn('secrets/RELAYER_PRIVATE_KEY', entries)
        self.assertEqual(entries['secrets/DATABASE_URL']['uid'], 1000)
        self.assertEqual(entries['secrets/OPERATOR_DATABASE_URL']['uid'], 0)
        self.assertEqual(entries['secrets/POSTGRES_PASSWORD']['uid'], 999)
        self.assertEqual(entries['backup/pgbackrest.conf']['uid'], 999)
        self.assertFalse((root/'installation/runtime/backend/secrets/RELAYER_PRIVATE_KEY').exists())
        policy=json.loads((root/'installation/runtime/backend/funding-policy.json').read_text())
        self.assertFalse(policy['allowExternalPaymaster']);self.assertEqual(policy['apps'], {})
        self.assertTrue(all(v in (0,'0') for k,v in policy['global'].items() if k!='periodSeconds'))

    def test_shell_like_unused_source_is_ignored_and_allowlisted_expansion_refused(self):
        root=self.fixture();path=root/'config.env.local'; marker=root/'DO_NOT_CREATE'
        path.write_text(f'PRIVATE_KEY=$(touch {marker})\nGOOGLE_CLIENT_ID="123-test.apps.googleusercontent.com"\n');path.chmod(0o600)
        self.assertEqual(runtime.fields(path, {'GOOGLE_CLIENT_ID'}), {'GOOGLE_CLIENT_ID':'123-test.apps.googleusercontent.com'})
        self.assertFalse(marker.exists())
        path.write_text('GOOGLE_CLIENT_ID=$(anything)\n')
        with self.assertRaisesRegex(ValueError, 'RUNTIME_SOURCE_LITERAL_REQUIRED'):runtime.fields(path, {'GOOGLE_CLIENT_ID'})
        path.write_text('GOOGLE_CLIENT_ID=first\nGOOGLE_CLIENT_ID=second\n')
        with self.assertRaisesRegex(ValueError, 'RUNTIME_DUPLICATE_SOURCE_FIELD'):runtime.fields(path, {'GOOGLE_CLIENT_ID'})

    def test_changed_pins_or_source_cannot_overwrite_prepared_passwords(self):
        root=self.fixture();runtime.prepare(root, metadata())
        password=(root/'installation/runtime/backend/secrets/APP_DATABASE_PASSWORD').read_bytes()
        altered=metadata();altered['googleClientId']='other.apps.googleusercontent.com';altered['pepperAudiences']=altered['googleClientId']
        with self.assertRaisesRegex(ValueError,'RUNTIME_EXISTING_FILE_CHANGED'):runtime.prepare(root, altered)
        self.assertEqual((root/'installation/runtime/backend/secrets/APP_DATABASE_PASSWORD').read_bytes(),password)
        for key,value in [('classHash','0x123'),('selectedPepperKeyArn','wrong'),('pepperKeyCheck','not-a-key-check')]:
            altered=metadata();altered[key]=value
            with self.assertRaises(ValueError):runtime.validate_metadata(altered)

    def test_relayer_mapping_uses_stat_only_and_never_reads_key_bytes(self):
        root=self.fixture();runtime.prepare(root,metadata())
        key=root/'existing-signer-file';key.write_text('PRIVATE_SYNTHETIC_KEY_SENTINEL');key.chmod(0o600)
        mapping=root/'installation/runtime/existing-secret-files.json'
        mapping.write_text(json.dumps({'version':1,'backend':{'RELAYER_PRIVATE_KEY':str(key)}}))
        original=runtime.read
        def read(path,*args,**kwargs):
            self.assertNotEqual(Path(path),key,'runtime must not read the external signing key')
            return original(path,*args,**kwargs)
        with patch.object(runtime,'read',side_effect=read):
            report=runtime.validate(root,require_external=True)
        self.assertFalse(report['externalRelayerSourcePending'])
        self.assertFalse(report['startupReady'])
        self.assertNotIn('PRIVATE_SYNTHETIC_KEY_SENTINEL',json.dumps(report))
        key.chmod(0o644)
        with self.assertRaisesRegex(ValueError,'RUNTIME_EXTERNAL_FILE_PRIVATE_REQUIRED'):runtime.validate(root)

    def test_key_is_never_picked_up_by_runtime_manifest_scan(self):
        root=self.fixture();runtime.prepare(root,metadata())
        key=root/'installation/runtime/backend/secrets/RELAYER_PRIVATE_KEY';key.write_text('PRIVATE_SENTINEL');key.chmod(0o600)
        original=runtime.read
        def read(path,*args,**kwargs):
            self.assertNotEqual(Path(path),key)
            return original(path,*args,**kwargs)
        with patch.object(runtime,'read',side_effect=read):
            with self.assertRaisesRegex(ValueError,'RUNTIME_UNEXPECTED_FILE_NOT_BUNDLED'):runtime.prepare(root,metadata())

    def test_private_file_symlinks_and_world_accessible_sources_fail_closed(self):
        root=self.fixture();path=root/'source.env.local';path.write_text('GOOGLE_CLIENT_ID=fixture\n');path.chmod(0o644)
        with self.assertRaisesRegex(ValueError,'RUNTIME_PRIVATE_SOURCE_PERMISSIONS_REQUIRED'):runtime.fields(path, {'GOOGLE_CLIENT_ID'})
        path.chmod(0o600);link=root/'linked.env.local';link.symlink_to(path)
        with self.assertRaises(OSError):runtime.fields(link, {'GOOGLE_CLIENT_ID'})
        root.chmod(0o755)
        with self.assertRaisesRegex(ValueError,'PRIVATE_RUNTIME_DIRECTORY_REQUIRED'):runtime.prepare(root,metadata())

    def test_validated_files_cannot_change_after_manifest(self):
        root=self.fixture();runtime.prepare(root,metadata())
        path=root/'installation/runtime/backend/keychain.public.env';path.write_text('GOOGLE_CLIENT_ID=changed\n')
        with self.assertRaisesRegex(ValueError,'RUNTIME_FILE_CHANGED'):runtime.validate(root)

    def test_pending_external_source_remains_explicit_without_blocking_local_preparation(self):
        root=self.fixture();runtime.prepare(root,metadata())
        with self.assertRaisesRegex(ValueError,'RUNTIME_RELAYER_DELIVERY_REQUIRED'):runtime.validate(root,require_external=True)
        self.assertTrue(runtime.validate(root)['externalRelayerSourcePending'])

    def test_manifest_cannot_drop_files_or_weaken_target_ownership(self):
        for mutation in ['missing-file', 'owner']:
            root=self.fixture();runtime.prepare(root,metadata())
            path=root/'installation/runtime/manifest.json';value=json.loads(path.read_text())
            if mutation=='missing-file':value['entries'].pop()
            else:value['entries'][0]['uid']=1234
            path.write_text(json.dumps(value))
            with self.assertRaisesRegex(ValueError,'RUNTIME_MANIFEST_INVALID'):runtime.validate(root)

    def test_partial_preparation_reuses_generated_passwords_without_regeneration(self):
        root=self.fixture();runtime.prepare(root,metadata())
        target=root/'installation/runtime';before=(target/'backend/secrets/APP_DATABASE_PASSWORD').read_bytes()
        (target/'manifest.json').unlink()  # Model an interruption before final manifest creation.
        with patch.object(runtime.secrets,'token_urlsafe',side_effect=AssertionError('no password regeneration')):
            runtime.prepare(root,metadata())
        self.assertEqual((target/'backend/secrets/APP_DATABASE_PASSWORD').read_bytes(),before)


if __name__=='__main__':unittest.main()
