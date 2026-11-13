"""Runtime secret delivery: host fetch, metadata-service firewall and the workstation store step.

No AWS call, no root and no real firewall: each piece takes a fake where it would touch the system.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest

import common

HERE = Path(__file__).resolve().parent
LEAN = HERE.parent


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


sync = load(LEAN/'scripts/secrets-sync.py', 'kamui_secrets_sync')
guard = load(LEAN/'scripts/imds-guard.py', 'kamui_imds_guard')
runtime = load(HERE/'runtime.py', 'kamui_secrets_runtime_test')
store = load(HERE/'secrets_store.py', 'kamui_secrets_store_test')
RELAYER = '0x' + '1a'*31


def bundle_for(role, override=None):
    files = {}
    for path in sync.FILES[role]:
        text = (override or {}).get(path, 'value for '+path+'\n')
        files[path] = {'content': text, 'sha256': hashlib.sha256(text.encode()).hexdigest()}
    return json.dumps({'schema': sync.SCHEMA, 'role': role, 'files': files})


class HostTableTest(unittest.TestCase):
    def test_host_owners_and_files_match_what_the_runtime_step_prepares(self):
        for role in ['backend', 'pepper']:
            self.assertEqual(set(sync.FILES[role]), set(runtime.MANAGED_FILES[role]))
            for path, (uid, gid, mode) in sync.FILES[role].items():
                expected = runtime.ownership(path)
                self.assertEqual((uid, gid, mode), (expected[0], expected[1], int(expected[2], 8)), path)
        self.assertEqual(sync.RELAYER, ('secrets/RELAYER_PRIVATE_KEY', (1000, 1000, 0o400)))

    def test_firewall_subnets_match_the_compose_networks_allowed_to_reach_the_metadata_service(self):
        self.assertIn('backup_egress: { ipam: { config: [ { subnet: '+guard.ALLOWED['backend']+' } ] } }', (LEAN/'backend/compose.yml').read_text())
        self.assertIn('kms_egress: { ipam: { config: [ { subnet: '+guard.ALLOWED['pepper']+' } ] } }', (LEAN/'pepper/compose.yml').read_text())

    def test_stack_unit_requires_the_fetch_and_the_firewall_before_starting(self):
        unit = (LEAN/'systemd/kamui@.service').read_text()
        self.assertIn('Requires=docker.service kamui-imds-guard@%i.service kamui-secrets@%i.service', unit)
        self.assertIn('After=docker.service network-online.target kamui-imds-guard@%i.service kamui-secrets@%i.service', unit)


class HostFetchTest(unittest.TestCase):
    def host(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        for directory in ['etc/kamui/secrets', 'etc/kamui/backup']: (root/directory).mkdir(parents=True)
        recorded = []
        def chown_record(fd, uid, gid): recorded.append((uid, gid))
        return root, recorded, chown_record

    def fetcher(self, values):
        calls = []
        def fetch(secret_id):
            calls.append(secret_id); return values[secret_id], 'version-'+secret_id[-7:]
        return fetch, calls

    def test_backend_writes_every_file_with_its_exact_mode_and_owner_then_is_idempotent(self):
        root, owners, chown = self.host()
        fetch, calls = self.fetcher({'kamui-sepolia/backend/runtime': bundle_for('backend'),
                                     'kamui-sepolia/backend/relayer-private-key': RELAYER})
        result = sync.sync('backend', fetch, root, chown)
        self.assertEqual(result['files'], 11); self.assertEqual(result['filesWritten'], 11)
        self.assertEqual(calls, ['kamui-sepolia/backend/runtime', 'kamui-sepolia/backend/relayer-private-key'])
        key = root/'etc/kamui/secrets/RELAYER_PRIVATE_KEY'
        self.assertEqual(key.read_text(), RELAYER+'\n')
        self.assertEqual(stat.S_IMODE(key.stat().st_mode), 0o400)
        self.assertEqual(stat.S_IMODE((root/'etc/kamui/backend.public.env').stat().st_mode), 0o600)
        self.assertEqual(sorted(set(owners)), [(0, 0), (999, 999), (1000, 1000)])
        self.assertNotIn(RELAYER, json.dumps(result))
        self.assertFalse(any(p.name.startswith('.') for p in (root/'etc/kamui').rglob('*')))

    def test_pepper_reads_only_its_own_runtime_secret(self):
        root, _, chown = self.host()
        fetch, calls = self.fetcher({'kamui-sepolia/pepper/runtime': bundle_for('pepper')})
        self.assertEqual(sync.sync('pepper', fetch, root, chown)['files'], 1)
        self.assertEqual(calls, ['kamui-sepolia/pepper/runtime'])

    def test_placeholders_and_tampered_bundles_are_refused_before_anything_is_written(self):
        good = bundle_for('backend')
        tampered = json.loads(good); first = sorted(tampered['files'])[0]; tampered['files'][first]['content'] = 'changed\n'
        extra = json.loads(good); extra['files']['secrets/OWNER_PRIVATE_KEY'] = {'content': 'x', 'sha256': hashlib.sha256(b'x').hexdigest()}
        wrong_role = json.loads(good); wrong_role['role'] = 'pepper'
        cases = [
            ({'runtime': 'Rk3pL0placeholderGeneratedByCfn9', 'relayer': RELAYER}, 'RUNTIME_BUNDLE_NOT_SET'),
            ({'runtime': good, 'relayer': 'Rk3pL0placeholderGeneratedByCfn9'}, 'RELAYER_KEY_NOT_SET'),
            ({'runtime': json.dumps(tampered), 'relayer': RELAYER}, 'RUNTIME_BUNDLE_ENTRY_INVALID'),
            ({'runtime': json.dumps(extra), 'relayer': RELAYER}, 'RUNTIME_BUNDLE_FILES_UNEXPECTED'),
            ({'runtime': json.dumps(wrong_role), 'relayer': RELAYER}, 'RUNTIME_BUNDLE_NOT_SET'),
        ]
        for values, error in cases:
            with self.subTest(error=error):
                root, _, chown = self.host()
                fetch, _ = self.fetcher({'kamui-sepolia/backend/runtime': values['runtime'],
                                         'kamui-sepolia/backend/relayer-private-key': values['relayer']})
                with self.assertRaisesRegex(ValueError, error): sync.sync('backend', fetch, root, chown)
                self.assertEqual([p for p in (root/'etc/kamui').rglob('*') if p.is_file()], [])

    def test_a_link_in_place_of_a_runtime_file_is_refused(self):
        root, _, chown = self.host()
        (root/'etc/kamui/secrets/DATABASE_URL').symlink_to(root/'elsewhere')
        fetch, _ = self.fetcher({'kamui-sepolia/backend/runtime': bundle_for('backend'),
                                 'kamui-sepolia/backend/relayer-private-key': RELAYER})
        with self.assertRaisesRegex(ValueError, 'RUNTIME_FILE_LINK_REFUSED'): sync.sync('backend', fetch, root, chown)
        self.assertFalse((root/'elsewhere').exists())


class FakeFirewall:
    def __init__(self, docker=True):
        self.chains = {'DOCKER-USER': ['-N DOCKER-USER', '-A DOCKER-USER -j RETURN']} if docker else {}
        self.calls = []

    def __call__(self, args):
        self.calls.append(args)
        op, chain, rest = args[0], args[1], args[2:]
        if op == '-S': return (0, '\n'.join(self.chains[chain])+'\n') if chain in self.chains else (1, '')
        if op == '-N': self.chains[chain] = ['-N '+chain]; return 0, ''
        if op == '-F': self.chains[chain] = ['-N '+chain]; return 0, ''
        if op == '-A': self.chains[chain].append('-A '+chain+' '+' '.join(rest)); return 0, ''
        rule = '-A '+chain+' '+' '.join(rest[1:] if op == '-I' else rest)
        if op == '-C': return (0, '') if rule in self.chains.get(chain, []) else (1, '')
        if op == '-I': self.chains[chain].insert(1, rule); return 0, ''
        raise AssertionError(args)


class FirewallTest(unittest.TestCase):
    def test_only_the_backup_network_reaches_the_metadata_service_and_reapplying_changes_nothing(self):
        firewall = FakeFirewall()
        result = guard.guard('backend', firewall)
        self.assertEqual(result['allowedSubnet'], '10.199.250.0/24')
        self.assertEqual(firewall.chains['KAMUI-IMDS'], ['-N KAMUI-IMDS', '-A KAMUI-IMDS -s 10.199.250.0/24 -j RETURN', '-A KAMUI-IMDS -j DROP'])
        self.assertEqual(firewall.chains['DOCKER-USER'][1], '-A DOCKER-USER -d 169.254.169.254/32 -j KAMUI-IMDS')
        writes = [c for c in firewall.calls if c[0] in {'-N', '-F', '-A', '-I'}]
        guard.guard('backend', firewall)
        self.assertEqual([c for c in firewall.calls if c[0] in {'-N', '-F', '-A', '-I'}], writes)
        self.assertEqual(firewall.chains['DOCKER-USER'].count('-A DOCKER-USER -d 169.254.169.254/32 -j KAMUI-IMDS'), 1)

    def test_a_drifted_chain_is_rebuilt_and_a_missing_docker_chain_fails_closed(self):
        firewall = FakeFirewall(); guard.guard('pepper', firewall)
        firewall.chains['KAMUI-IMDS'] = ['-N KAMUI-IMDS', '-A KAMUI-IMDS -j RETURN']
        guard.guard('pepper', firewall)
        self.assertEqual(firewall.chains['KAMUI-IMDS'][1:], ['-A KAMUI-IMDS -s 10.199.251.0/24 -j RETURN', '-A KAMUI-IMDS -j DROP'])
        with self.assertRaisesRegex(ValueError, 'DOCKER_FIREWALL_CHAIN_MISSING'): guard.guard('backend', FakeFirewall(docker=False))


class StoreTest(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        for directory in ['installation', 'installation/runtime', 'installation/runtime/backend', 'installation/runtime/pepper', 'resources-setup']:
            (root/directory).mkdir(mode=0o700)
        for role in ['backend', 'pepper']:
            for path in runtime.MANAGED_FILES[role]:
                target = root/'installation/runtime'/role/path; target.parent.mkdir(mode=0o700, exist_ok=True)
                target.write_text('private '+path+'\n'); target.chmod(0o600)
        arns = {role: f'arn:aws:secretsmanager:eu-west-1:00000000000{1 if role == "backend" else 2}:secret:kamui-sepolia/{role}/runtime-AbCdEf' for role in ['backend', 'pepper']}
        common.write_private(root/'resources-setup/backend-identity-secrets-result.json', {'RuntimeSecretArn': arns['backend'],
            'RelayerSecretArn': 'arn:aws:secretsmanager:eu-west-1:000000000001:secret:kamui-sepolia/backend/relayer-private-key-GhIjKl'})
        common.write_private(root/'resources-setup/pepper-identity-secrets-result.json', {'RuntimeSecretArn': arns['pepper']})
        return root, arns

    class FakeRuntime:
        MANAGED_FILES = runtime.MANAGED_FILES
        read = staticmethod(runtime.read)
        validated = 0
        @classmethod
        def validate(cls, root): cls.validated += 1

    class FakeAws:
        def __init__(self, relayer_versions=1):
            self.puts = []; self.current = {}; self.relayer_versions = relayer_versions; self.reads = []
        def put_secret_value(self, profile, arn, text, token):
            self.puts.append((profile, arn, token, text)); self.current[arn] = token
            return {'ARN': arn, 'VersionId': token}
        def request(self, profile, service, operation, inputs):
            self.reads.append((service, operation))
            if (service, operation) != ('secretsmanager', 'describe-secret'): raise AssertionError((service, operation))
            arn = inputs['SecretId']
            if 'relayer' in arn: return {'VersionIdsToStages': {f'v{i}': ['AWSCURRENT'] for i in range(self.relayer_versions)}}
            return {'VersionIdsToStages': {self.current[arn]: ['AWSCURRENT']}} if arn in self.current else {}

    def config(self):
        return {'backend': {'aws_profile': 'backend-profile'}, 'pepper': {'aws_profile': 'pepper-profile'}}

    def test_stores_each_host_bundle_once_and_never_reads_a_value_back(self):
        root, arns = self.fixture(); aws = self.FakeAws()
        report = store.store(root, aws, self.config(), self.FakeRuntime)
        self.assertEqual([(p, a) for p, a, _, _ in aws.puts], [('backend-profile', arns['backend']), ('pepper-profile', arns['pepper'])])
        self.assertFalse(report['secretValuesReadBack'])
        self.assertEqual(report['relayerKey'], 'placeholder_put_the_key_in_by_hand')
        self.assertTrue(all(op == 'describe-secret' for _, op in aws.reads))
        backend = json.loads(aws.puts[0][3])
        self.assertEqual(set(backend['files']), set(runtime.MANAGED_FILES['backend']))
        self.assertEqual(sync.parse_bundle(aws.puts[0][3], 'backend')['secrets/DATABASE_URL'], b'private secrets/DATABASE_URL\n')
        # A rerun with the same files sends nothing new and reports the same versions.
        again = store.store(root, aws, self.config(), self.FakeRuntime)
        self.assertEqual(len(aws.puts), 2)
        self.assertEqual(again['backend'], report['backend'])

    def test_relayer_reported_stored_once_it_has_more_than_the_placeholder_version(self):
        root, _ = self.fixture(); aws = self.FakeAws(relayer_versions=2)
        self.assertEqual(store.store(root, aws, self.config(), self.FakeRuntime)['relayerKey'], 'stored')

    def test_a_stored_version_that_is_not_current_stops(self):
        root, _ = self.fixture(); aws = self.FakeAws()
        aws.put_secret_value = lambda profile, arn, text, token: {'ARN': arn, 'VersionId': token}
        with self.assertRaisesRegex(ValueError, 'SECRET_STORED_VERSION_NOT_CURRENT'): store.store(root, aws, self.config(), self.FakeRuntime)


class RedactionTest(unittest.TestCase):
    def test_put_secret_value_logs_only_a_hash_and_leaves_no_copy_of_the_value(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d).resolve()
            seen = {}
            def execute(command, **_):
                path = Path(command[command.index('--cli-input-json')+1].removeprefix('file://'))
                seen['input'] = json.loads(path.read_text())
                class Result: returncode = 0; stdout = b'{"ARN": "x", "VersionId": "y"}'; stderr = b''
                return Result()
            aws = common.Aws(root, execute)
            arn = 'arn:aws:secretsmanager:eu-west-1:000000000001:secret:kamui-sepolia/backend/runtime-AbCdEf'
            aws.put_secret_value('backend-profile', arn, 'SENTINEL-DATABASE-PASSWORD', 'kamui-runtime-'+'a'*40)
            self.assertEqual(seen['input']['SecretString'], 'SENTINEL-DATABASE-PASSWORD')
            for path in (root/'installation/aws-private').iterdir():
                self.assertNotIn(b'SENTINEL-DATABASE-PASSWORD', path.read_bytes(), path.name)
            with self.assertRaises(ValueError): aws.request('backend-profile', 'secretsmanager', 'get-secret-value', {})
            with self.assertRaises(ValueError): aws.request('backend-profile', 'secretsmanager', 'put-secret-value', {})


if __name__ == '__main__':
    unittest.main()
