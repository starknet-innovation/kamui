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


def approved_app(**override):
    return {'periodSeconds': 3600, 'txPerPeriod': 10, 'perAccountPerPeriod': 2, 'maxFeePerTx': '1000',
            'maxFeePerPeriod': '10000', 'perAccountMaxFeePerPeriod': '2000', 'credentialHash': 'c'*64, **override}


class DecisionsTests(unittest.TestCase):
    HOOK = 'https://hooks.example.invalid/services/T000/B000/fixture-token'

    def fixture(self):
        d = tempfile.TemporaryDirectory(); self.addCleanup(d.cleanup)
        root = Path(d.name).resolve(); root.chmod(0o700)
        runtime.prepare(root, metadata())
        return root, root/'installation/runtime/backend'

    def decide(self, root, value):
        path = root/'installation'/runtime.DECISIONS
        if path.exists(): path.unlink()
        path.write_text(json.dumps(value)); path.chmod(0o600)

    def snapshot(self, backend):
        return {p.relative_to(backend).as_posix(): p.read_bytes() for p in backend.rglob('*') if p.is_file()}

    def test_without_decisions_output_is_byte_identical_to_the_reviewed_templates(self):
        root, backend = self.fixture()
        self.assertEqual((backend/'backup/operator.settings').read_text(), (runtime.HERE.parent/'backup/operator.settings.example').read_text())
        self.assertIn('\nrepo1-retention-full=7\n', (backend/'backup/pgbackrest.conf').read_text())
        self.assertIn('WATCHER_WEBHOOK_URL=\n', (backend/'watcher.public.env').read_text())
        self.assertFalse((root/'installation/runtime-history').exists())

    def test_decisions_regenerate_only_derived_files_and_keep_evidence(self):
        root, backend = self.fixture(); before = self.snapshot(backend)
        self.decide(root, {'version': 1, 'backup': {'reviewed': True, 'retentionApproved': True, 'retentionFullDays': 14,
                           'maxSuccessfulBackupAgeSeconds': 129600}, 'alerts': {'watcherWebhookUrl': self.HOOK}})
        result = runtime.prepare(root, metadata())
        after = self.snapshot(backend)
        settings = (backend/'backup/operator.settings').read_text()
        self.assertIn('\nKAMUI_BACKUP_REVIEWED=yes\n', settings); self.assertIn('\nKAMUI_BACKUP_RETENTION_APPROVED=yes\n', settings)
        self.assertIn('\nKAMUI_BACKUP_MAX_AGE_SECONDS=129600\n', settings)
        self.assertIn('\nrepo1-retention-full=14\n', (backend/'backup/pgbackrest.conf').read_text())
        self.assertIn('WATCHER_WEBHOOK_URL='+self.HOOK+'\n', (backend/'watcher.public.env').read_text())
        changed = {path for path in after if after[path] != before[path]}
        self.assertEqual(changed, {'backup/operator.settings', 'backup/pgbackrest.conf', 'watcher.public.env'})
        self.assertTrue(changed <= runtime.DERIVED)
        # Generated passwords and the URLs built from them are never regenerated.
        for name in ['secrets/POSTGRES_PASSWORD', 'secrets/APP_DATABASE_PASSWORD', 'secrets/DATABASE_URL', 'secrets/OPERATOR_DATABASE_URL']:
            self.assertEqual(after[name], before[name])
        history = sorted(p.name.rsplit('-', 1)[0] for p in (root/'installation/runtime-history').iterdir())
        self.assertEqual(history, ['backend-backup-operator.settings', 'backend-backup-pgbackrest.conf', 'backend-watcher.public.env', 'manifest.json'])
        self.assertEqual(result['status'], 'private_runtime_prepared')
        self.assertNotIn(self.HOOK, json.dumps(result))
        # The same decisions again change nothing and add no evidence.
        runtime.prepare(root, metadata())
        self.assertEqual(len(list((root/'installation/runtime-history').iterdir())), 4)
        self.assertEqual(self.snapshot(backend), after)

    def test_invalid_decisions_are_refused_before_anything_changes(self):
        cases = [
            ({'version': 1, 'backup': {'retentionApproved': True}}, 'RUNTIME_RETENTION_NEEDS_REVIEW'),
            ({'version': 1, 'backup': {'reviewed': 'yes'}}, 'RUNTIME_DECISIONS_INVALID'),
            ({'version': 1, 'backup': {'maxSuccessfulBackupAgeSeconds': 60}}, 'RUNTIME_BACKUP_AGE_INVALID'),
            ({'version': 1, 'backup': {'retentionFullDays': 0}}, 'RUNTIME_RETENTION_DAYS_INVALID'),
            ({'version': 1, 'alerts': {'watcherWebhookUrl': 'http://hooks.example.invalid/x'}}, 'RUNTIME_WEBHOOK_INVALID'),
            ({'version': 1, 'alerts': {'watcherWebhookUrl': 'https://user:pass@hooks.example.invalid/x'}}, 'RUNTIME_WEBHOOK_INVALID'),
            ({'version': 1, 'alerts': {'watcherWebhookUrl': 'https://hooks.example.invalid/$(touch x)'}}, 'RUNTIME_WEBHOOK_INVALID'),
            ({'version': 1, 'funding': {'unknown': 1}}, 'RUNTIME_DECISIONS_INVALID'),
            ({'version': 1, 'funding': {'deploysPerHour': -1}}, 'RUNTIME_DEPLOYS_PER_HOUR_INVALID'),
            ({'version': 1, 'funding': {'policy': {'global': {}}}}, 'RUNTIME_FUNDING_POLICY_INVALID'),
            ({'version': 2}, 'RUNTIME_DECISIONS_INVALID'),
        ]
        for value, error in cases:
            with self.subTest(error=error, value=value):
                root, backend = self.fixture(); before = self.snapshot(backend)
                self.decide(root, value)
                with self.assertRaisesRegex(ValueError, error): runtime.prepare(root, metadata())
                self.assertEqual(self.snapshot(backend), before)

    def test_a_shared_or_group_readable_decisions_file_is_refused(self):
        root, _ = self.fixture()
        self.decide(root, {'version': 1}); (root/'installation'/runtime.DECISIONS).chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'RUNTIME_PRIVATE_SOURCE_PERMISSIONS_REQUIRED'): runtime.prepare(root, metadata())


def open_policy(fee='20000000000000000000', apps=None, external=False):
    limit = lambda tx, account: {'periodSeconds': 3600, 'txPerPeriod': tx, 'perAccountPerPeriod': account,
                                 'maxFeePerTx': fee, 'maxFeePerPeriod': '1000000000000000000000', 'perAccountMaxFeePerPeriod': '200000000000000000000'}
    return {'global': limit(1000, 100), 'operations': {'sponsor': limit(1000, 100), 'deployment': limit(500, 10),
            'recovery': limit(500, 20), 'wallet': limit(1000, 100)}, 'apps': apps or {}, 'allowExternalPaymaster': external}


class FundingDecisionsTests(DecisionsTests):
    def test_funding_decision_opens_deploys_and_replaces_only_the_policy_and_backend_env(self):
        root, backend = self.fixture(); before = self.snapshot(backend)
        self.decide(root, {'version': 1, 'funding': {'deploysPerHour': 500, 'policy': open_policy()}})
        runtime.prepare(root, metadata())
        after = self.snapshot(backend)
        self.assertEqual({p for p in after if after[p] != before[p]}, {'funding-policy.json', 'backend.public.env'})
        self.assertEqual(json.loads(after['funding-policy.json']), open_policy())
        self.assertIn(b'DEPLOYS_PER_HOUR=500\n', after['backend.public.env'])
        for name in ['secrets/POSTGRES_PASSWORD', 'secrets/APP_DATABASE_PASSWORD', 'secrets/DATABASE_URL']:
            self.assertEqual(after[name], before[name])
        self.assertEqual(runtime.validate(root)['status'], 'private_runtime_prepared')

    def test_without_a_funding_decision_the_zero_policy_and_zero_deploys_stay(self):
        root, backend = self.fixture()
        policy = json.loads((backend/'funding-policy.json').read_text())
        self.assertEqual(policy['global']['txPerPeriod'], 0)
        self.assertIn('DEPLOYS_PER_HOUR=0\n', (backend/'backend.public.env').read_text())

    def test_an_approved_app_reaches_the_policy_with_only_its_credential_hash(self):
        root, backend = self.fixture()
        policy = open_policy(apps={'app-key-0123456789ab': approved_app()})
        self.decide(root, {'version': 1, 'funding': {'deploysPerHour': 10, 'policy': policy}})
        runtime.prepare(root, metadata())
        self.assertEqual(json.loads((backend/'funding-policy.json').read_text())['apps'], policy['apps'])

    def test_apps_external_paymasters_and_inconsistent_caps_are_refused(self):
        cases = [
            (open_policy(apps={'app-key-0123456789ab': {}}), 'RUNTIME_FUNDING_APP_INVALID'),
            (open_policy(apps={'short': approved_app()}), 'RUNTIME_FUNDING_APP_INVALID'),
            (open_policy(apps={'app-key-0123456789ab': approved_app(credentialHash='A'*64)}), 'RUNTIME_FUNDING_APP_INVALID'),
            (open_policy(apps={'app-key-0123456789ab': approved_app(credentialHash=runtime.EMPTY_SHA256)}), 'RUNTIME_FUNDING_APP_INVALID'),
            (open_policy(apps={'app-key-0123456789ab': approved_app(token='never-here')}), 'RUNTIME_FUNDING_APP_INVALID'),
            (open_policy(apps={'app-key-0123456789ab': approved_app(maxFeePerTx='2000000000000000000000')}), 'RUNTIME_FUNDING_POLICY_INVALID'),
            (open_policy(external=True), 'RUNTIME_EXTERNAL_PAYMASTER_REQUIRES_REVIEW'),
            (open_policy(fee='2000000000000000000000'), 'RUNTIME_FUNDING_POLICY_INVALID'),
            (open_policy(fee='0x10'), 'RUNTIME_FUNDING_POLICY_INVALID'),
        ]
        for policy, error in cases:
            with self.subTest(error=error):
                root, backend = self.fixture(); before = self.snapshot(backend)
                self.decide(root, {'version': 1, 'funding': {'deploysPerHour': 10, 'policy': policy}})
                with self.assertRaisesRegex(ValueError, error): runtime.prepare(root, metadata())
                self.assertEqual(self.snapshot(backend), before)

