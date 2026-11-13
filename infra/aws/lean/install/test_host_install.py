"""Host installation tests use a temporary root and fake system commands only."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('kamui_host_installer_test', HERE/'host_install.py')
host = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(host)
LEAN = HERE.parent


class FakeCommands:
    def __init__(self):
        self.calls = []; self.docker = False; self.aws = False; self.active = False; self.live_unit = None
    def run(self, args, check=True):
        self.calls.append(args); rc = 0; output = b''
        if args[:2] == ['systemctl', 'is-active']:
            unit = args[-1]
            rc = 0 if unit == 'amazon-ssm-agent.service' or unit == self.live_unit or unit == 'docker.service' and self.active else 3
        elif args[:2] == ['systemctl', 'is-enabled']: rc = 1; output = b'disabled\n'
        elif args[:2] == ['systemctl', 'show']: output = b'loaded\n'
        elif args == ['rpm', '-q', 'docker']: rc = 0 if self.docker else 1
        elif args == ['dnf', '-y', 'install', 'docker']: self.docker = True
        elif args == ['dnf', '-y', 'install', 'awscli-2']: self.aws = True
        elif args == ['aws', '--version']: rc = 0 if self.aws else 127; output = b'aws-cli/2.fixture\n' if self.aws else b''
        elif args == ['systemctl', 'start', 'docker.service']: self.active = True
        elif args == ['docker', 'compose', 'version', '--short']: output = b'2.40.3\n'
        elif args == ['docker', 'info', '--format', '{{.ServerVersion}}']: output = b'28.fixture\n'
        elif args == ['docker', 'ps', '-aq']: output = b''
        elif args != ['systemctl', 'daemon-reload']: raise AssertionError('unexpected fake command')
        if check and rc: raise ValueError('FAKE_COMMAND_FAILED')
        return subprocess.CompletedProcess(args, rc, output, b'')


class HostInstallTest(unittest.TestCase):
    def fixture(self, role='backend'):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()/'host'; root.mkdir()
        source = Path(temporary.name)/'input'; source.mkdir()
        os_release = root/'etc/os-release'; os_release.parent.mkdir(); os_release.write_text('ID=amzn\nVERSION_ID="2023"\n')
        required = host.COMMON | {role+'/compose.yml', 'caddy/'+role+'.Caddyfile'} | (host.BACKEND if role == 'backend' else set())
        bodies = {path: (LEAN/path).read_bytes() for path in required}
        files = {name: {'sha256': host.sha(body), 'mode': '0755' if name.endswith('.sh') else '0644'} for name, body in bodies.items()}
        archive = self.archive(bodies)
        binary = b'\x7fELF' + b'public-reviewed-compose-fixture'
        manifest = {'schema': host.SCHEMA, 'role': role, 'archiveSha256': host.sha(archive), 'files': files,
                    'releaseImages': {key: 'example.invalid/kamui/'+key.lower()+'@sha256:'+'1'*64 for key in host.IMAGE_KEYS},
                    'compose': {'version': 'v2.40.3', 'sha256': host.sha(binary)}}
        archive_path = source/'package.tar.gz'; archive_path.write_bytes(archive)
        manifest_path = source/'manifest.json'; manifest_path.write_text(json.dumps(manifest))
        compose_path = source/'compose'; compose_path.write_bytes(binary)
        commands = FakeCommands(); ownership = []
        def directories(path, mode, uid=0, gid=0):
            ownership.append((path, mode, uid, gid))
            if path.exists():
                if path.is_symlink() or not path.is_dir() or stat.S_IMODE(path.stat().st_mode) != mode:
                    raise ValueError('EXISTING_DIRECTORY_LAYOUT_MISMATCH')
                return
            path.mkdir(mode=mode, parents=True); path.chmod(mode)
        self.enterContext(patch.object(host, 'directory', side_effect=directories))
        self.enterContext(patch.object(host, 'root_owned', return_value=True))
        self.enterContext(patch.object(host, 'set_root_owner'))
        self.enterContext(patch.object(host.platform, 'machine', return_value='x86_64'))
        options = {'role': role, 'archive_path': archive_path, 'manifest_path': manifest_path,
                   'expected_manifest': host.sha(manifest_path.read_bytes()), 'compose_binary': compose_path,
                   'compose_sha256': host.sha(binary), 'paths': host.Paths(root), 'runner': commands, 'require_root': False}
        return root, manifest, options, commands, ownership

    def archive(self, bodies, extra=None):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w:gz', format=tarfile.USTAR_FORMAT) as archive:
            for name, body in sorted(bodies.items()):
                info = tarfile.TarInfo('lean/'+name); info.size = len(body); info.mode = 0o644
                archive.addfile(info, io.BytesIO(body))
            if extra is not None:
                info, body = extra; archive.addfile(info, io.BytesIO(body) if body is not None else None)
        return output.getvalue()

    def rewrite_manifest(self, options, manifest):
        options['manifest_path'].write_text(json.dumps(manifest))
        options['expected_manifest'] = host.sha(options['manifest_path'].read_bytes())

    def test_backend_install_preserves_startup_fences_and_installs_consumer_layout(self):
        root, manifest, options, commands, ownership = self.fixture()
        result = host.install(**options)
        self.assertFalse(result['walletStarted']); self.assertFalse(result['databaseInitialized']); self.assertFalse(result['unitsEnabled'])
        self.assertEqual([c for c in commands.calls if c[:2] == ['systemctl', 'start']], [['systemctl', 'start', 'docker.service']])
        self.assertFalse(any(c[:2] in [['systemctl', 'enable'], ['docker', 'run']] or 'up' in c for c in commands.calls))
        self.assertFalse((root/'var/lib/kamui/restore-gate/state.json').exists())
        self.assertFalse(any((root/'var/lib/kamui/postgres').iterdir()))
        self.assertIn((root/'var/lib/kamui/postgres', 0o700, 999, 999), ownership)
        self.assertIn((root/'var/lib/kamui/restore-gate', 0o750, 0, 1000), ownership)
        self.assertEqual((root/'etc/kamui/release.env').stat().st_mode & 0o777, 0o600)
        self.assertTrue((root/'opt/kamui/lean').is_symlink())
        self.assertTrue((root/'etc/systemd/system/kamui@backend.service.d/restore-fence.conf').is_file())

    def test_repeat_same_install_verifies_files_without_repeating_any_system_command(self):
        _, _, options, commands, _ = self.fixture()
        host.install(**options); before = copy.deepcopy(commands.calls)
        self.assertEqual(host.install(**options)['status'], 'already_installed_verified')
        self.assertEqual(commands.calls, before)

    def test_partial_install_with_static_boot_unit_resumes_without_data_reset(self):
        root, _, options, commands, _ = self.fixture()
        host.install(**options)
        (root/'var/lib/kamui-install/backend.json').unlink()
        original = commands.run
        def static_unit(args, check=True):
            if args[:2] == ['systemctl', 'is-enabled'] and args[-1] == 'kamui-backend-boot-fence.service':
                return subprocess.CompletedProcess(args, 0, b'static\n', b'')
            return original(args, check)
        commands.run = static_unit
        self.assertEqual(host.install(**options)['status'], 'host_installed_wallet_stopped')
        self.assertFalse((root/'var/lib/kamui/restore-gate/state.json').exists())

    def test_read_only_check_uses_only_dependency_reads_and_does_not_mutate_install(self):
        root, _, options, commands, _ = self.fixture()
        host.install(**options)
        before = {str(p.relative_to(root)): p.read_bytes() for p in root.rglob('*') if p.is_file() and not p.is_symlink()}
        commands.calls.clear()
        read_options = {key: value for key, value in options.items() if key not in {'compose_binary', 'compose_sha256'}}
        result = host.check(**read_options)
        self.assertFalse(result['runtimeConfigurationVerified'])
        self.assertEqual(commands.calls, [['systemctl', 'is-active', '--quiet', 'amazon-ssm-agent.service'], ['aws', '--version'],
            ['docker', 'info', '--format', '{{.ServerVersion}}'], ['docker', 'compose', 'version', '--short']])
        after = {str(p.relative_to(root)): p.read_bytes() for p in root.rglob('*') if p.is_file() and not p.is_symlink()}
        self.assertEqual(before, after)

    def test_manifest_hash_or_compose_pin_mismatch_precedes_system_commands(self):
        for field in ['manifest', 'compose']:
            _, _, options, commands, _ = self.fixture()
            if field == 'manifest': options['expected_manifest'] = '0'*64
            else: options['compose_binary'].write_bytes(b'\x7fELFmodified')
            with self.assertRaises(ValueError): host.install(**options)
            self.assertEqual(commands.calls, [])

    def test_tar_traversal_links_and_devices_are_never_extracted(self):
        for kind in ['traversal', 'symlink', 'hardlink', 'device']:
            root, manifest, options, commands, _ = self.fixture()
            info = tarfile.TarInfo('lean/scripts/evil')
            body = None
            if kind == 'traversal': info.name = 'lean/../../outside'; body = b'x'; info.size = 1
            elif kind == 'symlink': info.type = tarfile.SYMTYPE; info.linkname = '/etc/passwd'
            elif kind == 'hardlink': info.type = tarfile.LNKTYPE; info.linkname = 'lean/scripts/host.py'
            else: info.type = tarfile.CHRTYPE
            payload = self.archive({}, (info, body))
            options['archive_path'].write_bytes(payload); manifest['archiveSha256'] = host.sha(payload); self.rewrite_manifest(options, manifest)
            with self.assertRaises(ValueError): host.install(**options)
            self.assertFalse((root.parent/'outside').exists()); self.assertEqual(commands.calls, [])

    def test_existing_wallet_data_or_gate_is_preserved_and_refuses_fresh_install(self):
        for name in ['postgres/PG_VERSION', 'restore-gate/state.json']:
            root, _, options, commands, _ = self.fixture()
            path = root/'var/lib/kamui'/name; path.parent.mkdir(parents=True); path.write_text('PRESERVE')
            with self.assertRaisesRegex(ValueError, 'EXISTING_WALLET_STATE_REQUIRES_REVIEWED_UPGRADE'): host.install(**options)
            self.assertEqual(path.read_text(), 'PRESERVE'); self.assertEqual(commands.calls, [])

    def test_existing_runtime_secret_is_preserved_and_never_opened_by_installer(self):
        root, _, options, _, _ = self.fixture()
        config = root/'etc/kamui'; config.mkdir(mode=0o700); secrets = config/'secrets'; secrets.mkdir(mode=0o700)
        secret = secrets/'RELAYER_PRIVATE_KEY'; secret.write_bytes(b'PRIVATE_FIXTURE_DO_NOT_LOAD')
        original = host.read_regular
        def guarded(path, limit):
            if Path(path) == secret: raise AssertionError('installer must not read runtime key')
            return original(path, limit)
        with patch.object(host, 'read_regular', side_effect=guarded): host.install(**options)
        self.assertEqual(secret.read_bytes(), b'PRIVATE_FIXTURE_DO_NOT_LOAD')

    def test_existing_other_release_or_manifest_refuses_before_os_changes(self):
        for kind in ['link', 'manifest']:
            root, _, options, commands, _ = self.fixture()
            if kind == 'link':
                directory = root/'opt/kamui'; directory.mkdir(parents=True); (directory/'lean').symlink_to('/different-release')
            else:
                config = root/'etc/kamui'; config.mkdir(mode=0o700); path = config/'release.env'; path.write_text('PRESERVE'); path.chmod(0o600)
            with self.assertRaises(ValueError): host.install(**options)
            self.assertEqual(commands.calls, [])

    def test_active_kamui_unit_and_unknown_docker_data_are_not_stopped_or_started(self):
        for kind in ['unit', 'docker', 'custom-daemon']:
            root, _, options, commands, _ = self.fixture()
            if kind == 'unit': commands.live_unit = 'kamui@backend.service'
            elif kind == 'docker':
                directory = root/'var/lib/docker'; directory.mkdir(parents=True); (directory/'PRESERVE').write_text('existing')
            else:
                directory = root/'etc/docker'; directory.mkdir(); (directory/'daemon.json').write_text('{"data-root":"/other-state"}')
            with self.assertRaises(ValueError): host.install(**options)
            self.assertFalse(any(c[:2] in [['systemctl', 'stop'], ['systemctl', 'start']] for c in commands.calls))

    def test_installed_units_or_package_tampering_is_detected(self):
        for kind in ['unit', 'package']:
            root, _, options, commands, _ = self.fixture(); host.install(**options)
            commands.calls.clear()
            if kind == 'unit': path = root/'etc/systemd/system/kamui@.service'
            else: path = root/'opt/kamui/lean/scripts/host.py'
            path.write_text('tampered')
            with self.assertRaises(ValueError): host.install(**options)

    def test_pepper_install_omits_backend_database_fence_and_backup_units(self):
        root, _, options, _, _ = self.fixture('pepper'); host.install(**options)
        self.assertFalse((root/'var/lib/kamui/postgres').exists())
        self.assertFalse((root/'etc/systemd/system/kamui-backend-boot-fence.service').exists())
        self.assertFalse((root/'etc/systemd/system/kamui-backup-full.timer').exists())

    def test_production_owner_predicate_requires_both_root_user_and_group(self):
        self.assertTrue(host.root_owned(SimpleNamespace(st_uid=0, st_gid=0)))
        self.assertFalse(host.root_owned(SimpleNamespace(st_uid=501, st_gid=0)))
        self.assertFalse(host.root_owned(SimpleNamespace(st_uid=0, st_gid=501)))

    def test_identical_existing_compose_with_untrusted_owner_mode_or_hardlink_is_refused(self):
        for kind in ['owner', 'mode', 'hardlink']:
            root, _, options, commands, _ = self.fixture()
            plugin = root/'usr/local/lib/docker/cli-plugins/docker-compose'
            plugin.parent.mkdir(parents=True); plugin.write_bytes(options['compose_binary'].read_bytes()); plugin.chmod(0o755)
            inode = plugin.stat().st_ino
            if kind == 'mode': plugin.chmod(0o775)
            if kind == 'hardlink': os.link(plugin, plugin.parent/'alias')
            owner = lambda info: not (kind == 'owner' and info.st_ino == inode)
            with patch.object(host, 'root_owned', side_effect=owner), self.assertRaises(ValueError): host.install(**options)
            self.assertEqual(commands.calls, [])

    def test_read_only_check_rejects_identical_nonroot_owned_managed_files(self):
        for relative in ['usr/local/lib/docker/cli-plugins/docker-compose', 'etc/kamui/release.env',
                         'etc/systemd/system/kamui@.service', 'var/lib/kamui-install/backend.json',
                         'opt/kamui/lean/scripts/host.py']:
            root, _, options, commands, _ = self.fixture(); host.install(**options)
            commands.calls.clear()
            inode = (root/relative).stat().st_ino
            read_options = {key: value for key, value in options.items() if key not in {'compose_binary', 'compose_sha256'}}
            with patch.object(host, 'root_owned', side_effect=lambda info: info.st_ino != inode):
                with self.assertRaisesRegex(ValueError, 'MANAGED_FILE_OWNERSHIP_OR_MODE_INVALID'): host.check(**read_options)
            self.assertNotIn(['docker', 'compose', 'version', '--short'], commands.calls)

    def test_only_standard_root_owned_os_release_symlink_is_allowed(self):
        for target in ['../usr/lib/os-release', '/usr/lib/os-release', '/untrusted/os-release']:
            root, _, options, commands, _ = self.fixture()
            identity = root/'etc/os-release'; body = identity.read_bytes(); identity.unlink()
            canonical = root/'usr/lib/os-release'; canonical.parent.mkdir(parents=True); canonical.write_bytes(body)
            identity.symlink_to(target)
            if target == '/untrusted/os-release':
                with self.assertRaisesRegex(ValueError, 'OS_IDENTITY_SYMLINK_REFUSED'): host.install(**options)
                self.assertEqual(commands.calls, [])
            else:
                self.assertEqual(host.install(**options)['status'], 'host_installed_wallet_stopped')

    def test_nonroot_canonical_os_identity_target_is_refused(self):
        root, _, options, commands, _ = self.fixture()
        identity = root/'etc/os-release'; body = identity.read_bytes(); identity.unlink()
        canonical = root/'usr/lib/os-release'; canonical.parent.mkdir(parents=True); canonical.write_bytes(body)
        identity.symlink_to('../usr/lib/os-release'); inode = canonical.stat().st_ino
        with patch.object(host, 'root_owned', side_effect=lambda info: info.st_ino != inode):
            with self.assertRaisesRegex(ValueError, 'MANAGED_FILE_OWNERSHIP_OR_MODE_INVALID'): host.install(**options)
        self.assertEqual(commands.calls, [])


if __name__ == '__main__': unittest.main()
