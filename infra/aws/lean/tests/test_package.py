"""Offline host-package boundary tests. No AWS calls, image pulls or real credentials."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('host', ROOT/'scripts/host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class HostPackageTests(unittest.TestCase):
    def fixture(self, directory):
        config = Path(directory)/'config'
        config.mkdir()
        (config/'secrets').mkdir()
        (config/'operator').mkdir()
        (config/'backup').mkdir()
        (config/'release.env').write_text('\n'.join(f'{key}=example.invalid/kamui@sha256:'+'0'*64 for key in host.IMAGE_KEYS))
        for name in ['keychain.public.env', 'backend.public.env', 'watcher.public.env', 'pepper.private.env']:
            (config/name).write_text('')
        (config/'backend.public.env').write_text('RELAYER_ADDRESS=0x1\n')
        for name in ['DATABASE_URL','OPERATOR_DATABASE_URL','RELAYER_PRIVATE_KEY','POSTGRES_PASSWORD','APP_DATABASE_PASSWORD','PAYMASTER_API_KEY']:
            (config/'secrets'/name).write_text('local-configuration-fixture')
        (config/'funding-policy.json').write_text('{}')
        (config/'backup/pgbackrest.conf').write_text('[global]\n')
        return config

    def test_tag_only_unknown_and_duplicate_release_values_are_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            config = self.fixture(temp)
            manifest = config/'release.env'
            self.assertTrue(host.release(manifest,'backend'))
            for text in ['CADDY_IMAGE=caddy:latest', 'AWS_SECRET_ACCESS_KEY=fixture', 'CADDY_IMAGE=\nCADDY_IMAGE=']:
                manifest.write_text(text)
                with self.assertRaises(ValueError):
                    host.release(manifest,'backend')

    def test_compose_has_no_public_app_database_or_operator_port_and_scopes_signer_files(self):
        with tempfile.TemporaryDirectory() as temp:
            config = self.fixture(temp)
            env = {**os.environ, **host.release(config/'release.env','backend'), 'CONFIG_DIRECTORY':str(config),'STATE_DIRECTORY':temp+'/state'}
            for role in ['backend','pepper']:
                command = ['docker','compose','--env-file',str(config/'release.env'),'-f',str(ROOT/role/'compose.yml'),'config','--format','json']
                run = subprocess.run(command,env=env,capture_output=True,text=True,check=True)
                compose = json.loads(run.stdout)
                self.assertEqual([name for name,service in compose['services'].items() if service.get('ports')], ['caddy'])
                if role == 'backend':
                    secrets = {name:{s['source'] for s in service.get('secrets',[])} for name,service in compose['services'].items()}
                    self.assertEqual({name for name,s in secrets.items() if 'RELAYER_PRIVATE_KEY' in s}, {'api'})
                    self.assertEqual(compose['services']['api']['environment']['REQUIRE_OFFLINE_REGISTRY_ADMIN'], 'true')
                    self.assertNotIn('rotator', compose['services'])
                    self.assertFalse(any('OWNER_PRIVATE_KEY' in s for s in secrets.values()))
                    self.assertNotIn('OWNER_PRIVATE_KEY', compose.get('secrets', {}))
                    # Operator profile is not active in the default stack. Explicitly render it.
                    operator = subprocess.run(command[:-3]+['--profile','operator','config','--format','json'],env=env,capture_output=True,text=True)
                    self.assertEqual(operator.returncode,0)
                    self.assertEqual({s['source'] for s in json.loads(operator.stdout)['services']['operator']['secrets']}, {'OPERATOR_DATABASE_URL'})

    def test_manual_mode_requires_no_owner_config_and_refuses_leftover_hosted_key(self):
        with tempfile.TemporaryDirectory() as temp:
            config = self.fixture(temp)
            env={**os.environ,'CONFIG_DIRECTORY':str(config),'STATE_DIRECTORY':temp+'/state'}
            command=['python3',str(ROOT/'scripts/host.py'),'backend','validate']
            self.assertEqual(subprocess.run(command,env=env,capture_output=True).returncode,0)
            (config/'secrets/OWNER_PRIVATE_KEY').write_text('local-fixture-never-a-real-key')
            run=subprocess.run(command,env=env,capture_output=True,text=True)
            self.assertNotEqual(run.returncode,0)
            self.assertIn('OFFSERVER_REGISTRY_SIGNER_REQUIRED',run.stderr)
            self.assertNotIn('local-fixture-never-a-real-key',run.stderr)

    def test_host_mutations_are_exclusive_until_the_operator_releases_the_lock(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            with host.control_lock(state):
                with self.assertRaisesRegex(ValueError,'HOST_CONTROL_BUSY'):
                    with host.control_lock(state):
                        self.fail('two operators acquired the control lock')
            with host.control_lock(state):
                pass

    def test_prepare_never_replaces_a_running_restarting_or_paused_writer(self):
        with tempfile.TemporaryDirectory() as temp:
            config = self.fixture(temp)
            for state in ['running','restarting','paused']:
                checked = subprocess.CompletedProcess([],0,stdout=json.dumps([{'Service':'rotator','State':state}]))
                with patch.object(host.subprocess,'run',return_value=checked) as run:
                    with self.assertRaisesRegex(ValueError,'STOP_OLD_WRITERS_REQUIRED'):
                        host.execute('backend','prepare',config,Path(temp)/'state')
                    self.assertEqual(run.call_count,1)

    def test_offline_admin_mode_refuses_even_a_stopped_legacy_rotator_before_full_start(self):
        with tempfile.TemporaryDirectory() as temp:
            config = self.fixture(temp)
            checked = subprocess.CompletedProcess([],0,stdout=json.dumps([{'Service':'rotator','State':'exited'}]))
            with patch.object(host.subprocess,'run',return_value=checked):
                with self.assertRaisesRegex(ValueError,'LEGACY_ROTATOR_REMOVAL_REQUIRED'):
                    host.execute('backend','up',config,Path(temp)/'state')

    def test_boot_reblocks_a_restored_ready_gate_and_failed_block_removes_the_boot_marker(self):
        boot_spec = importlib.util.spec_from_file_location('boot_fence',ROOT/'scripts/boot-fence.py')
        boot = importlib.util.module_from_spec(boot_spec); boot_spec.loader.exec_module(boot)
        with tempfile.TemporaryDirectory() as temp:
            gate = Path(temp)/'state.json'; marker = Path(temp)/'run/boot-fenced'
            actions = []
            def control(action):
                actions.append(action); gate.write_text('{"state":"blocked"}'); return True
            boot.fence_gate(gate,marker,'boot-one',control)
            self.assertEqual(actions,['initialize'])
            gate.write_text('{"state":"ready"}')
            boot.fence_gate(gate,marker,'boot-two',control)
            self.assertEqual(actions,['initialize','block'])
            self.assertEqual(marker.read_text().strip(),'boot-two')
            with self.assertRaises(ValueError):
                boot.fence_gate(gate,marker,'boot-three',lambda _:False)
            self.assertFalse(marker.exists())

    def test_normal_lifecycle_refuses_a_temporary_restore_volume_selection(self):
        state=Path('/var/lib/kamui')
        with patch.dict(os.environ,{'POSTGRES_DATA_DIRECTORY':'/var/lib/kamui/postgres-restore-test'}):
            with self.assertRaisesRegex(ValueError,'RESTORED_DATA_PROMOTION_REQUIRED'):
                host.canonical_data_directory(state)
        with patch.dict(os.environ,{'POSTGRES_DATA_DIRECTORY':'/var/lib/kamui/postgres'}):
            self.assertEqual(host.canonical_data_directory(state),'/var/lib/kamui/postgres')


if __name__ == '__main__':
    unittest.main()
