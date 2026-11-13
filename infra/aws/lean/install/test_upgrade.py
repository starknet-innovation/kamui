"""Upgrading a started wallet: host actions, the installer's upgrade mode and the workstation steps.

Fake hosts, a fake installer runner and fake SSM calls only; no AWS, Docker, systemd or real host.
"""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid

import test_host_install
import test_reopen
from test_reopen import BOOT, BTIME, FENCE, STACK, FakeHost, host_program

host = test_host_install.host
TIMERS = host_program.TIMERS
LABEL = '20261113-140000F'


def load(name):
    spec = importlib.util.spec_from_file_location('upgrade_test_'+name, Path(__file__).parent/(name+'.py'))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


upgrade = load('upgrade')


class UpgradeHost(FakeHost):
    """The reboot fake host plus backups, gate blocking, `host.py down` and installed receipts."""
    def __init__(self, root, role='backend', **kwargs):
        super().__init__(root, role, **kwargs)
        records = self.root/'var/lib/kamui-install'; records.mkdir(parents=True, mode=0o700)
        (records/(role+'.json')).write_text(json.dumps({'schema': 'kamui.host-install.v1', 'role': role, 'manifestSha256': 'a'*64,
                                                        'archiveSha256': 'b'*64, 'walletStarted': False})+'\n')
        for timer in TIMERS: self.units[timer] = 'active'; self.enabled[timer] = 'enabled'
        if role == 'backend':
            self.units[STACK] = 'active'
            self.write_gate({**self.gate(), 'state': 'ready', 'mode': 'restored', 'reviewRef': 'opened'})
            self.services = {'postgres': ('running', 'healthy'), 'api': ('running', 'healthy'), 'keychain': ('running', 'healthy'),
                             'caddy': ('running', ''), 'watcher': ('running', '')}
        self.backup_fails = None
        self.backups = []

    def prepared(self): return json.loads((self.root/'var/lib/kamui-install'/(self.role+'-upgrade-prepared.json')).read_text())

    def run(self, args):
        if args[:2] in (['systemctl', 'stop'], ['systemctl', 'start']) and args[2] in TIMERS + ['kamui@pepper.service']:
            self.calls.append((args[1], args[2]))
            if args[2] == 'kamui@pepper.service':
                self.units[args[2]] = 'active' if args[1] == 'start' else 'inactive'
                self.services = {'caddy': ('running', ''), 'pepper': ('running', 'healthy')} if args[1] == 'start' else {}
            else: self.units[args[2]] = 'active' if args[1] == 'start' else 'inactive'
            return 0, '', ''
        if args[:2] == ['bash', '-c'] and 'backup.sh' in args[2]:
            kind = args[2].rsplit(' ', 1)[-1]
            self.calls.append(('backup', kind))
            if self.backup_fails == kind: return 1, '{"status":"refused","error":"BACKUP_COMMAND_FAILED"}\n', ''
            if kind == 'full': self.backups.append({'type': 'full', 'label': LABEL, 'timestamp': {'stop': int(self.clock)}})
            return 0, json.dumps({'status': 'backup-complete', 'operation': kind}, separators=(',', ':'))+'\n', ''
        if args[:3] == ['docker', 'compose', '--env-file'] and 'pgbackrest' in args:
            self.calls.append(('pgbackrest-info',))
            old = {'type': 'full', 'label': '20261113-020000F', 'timestamp': {'stop': BTIME - 7200}}
            return 0, json.dumps([{'name': 'kamui', 'status': {'code': 0}, 'backup': [old] + self.backups}]), ''
        if args[:2] == ['python3', '-B'] and args[2].endswith('/wallet-control.py') and args[3:] == ['restore', 'block']:
            self.calls.append(('wallet-control.py', 'restore', 'block'))
            self.write_gate({'version': 1, 'state': 'blocked', 'reason': 'restore', 'generation': str(uuid.uuid4()), 'changedAt': int(self.clock*1000)})
            return 0, '', ''
        if args[:2] == ['python3', '-B'] and args[2].endswith('/host.py') and args[4] == 'down':
            self.calls.append(('host.py', args[3], 'down')); self.services = {}; return 0, '', ''
        return super().run(args)


def quiet(function, *args):
    with contextlib.redirect_stdout(io.StringIO()): return function(*args)


class PrepareTest(unittest.TestCase):
    def host(self, role='backend', **kwargs):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        return UpgradeHost(temporary.name, role, **kwargs)

    def test_backend_prepare_stops_backs_up_fences_and_records_in_that_order(self):
        fake = self.host()
        result = host_program.upgrade_prepare_backend(fake.host, BOOT)
        self.assertEqual(result['status'], 'upgrade_prepared')
        self.assertEqual(result['backupLabel'], LABEL)
        self.assertEqual(sorted(result['timersStopped']), sorted(TIMERS))
        order = [c for c in fake.calls if c[0] in {'stop', 'prepare', 'backup', 'wallet-control.py', 'host.py'} or c[:1] == ('host.py',)]
        names = [c[1] if c[0] in {'stop', 'backup'} else c[0] for c in order]
        self.assertEqual(names[-6:], ['kamui@backend.service', 'host.py', 'full', 'check', 'wallet-control.py', 'host.py'])
        gate = fake.gate()
        self.assertEqual((gate['state'], gate['reason']), ('blocked', 'restore'))
        record = fake.prepared()
        self.assertEqual(record, {'schema': 'kamui.upgrade-prepared.v1', 'role': 'backend', 'bootId': BOOT, 'preparedAt': int(fake.clock),
                                  'previousManifestSha256': 'a'*64, 'backupLabel': LABEL, 'gateGeneration': gate['generation']})
        self.assertEqual(oct((fake.root/'var/lib/kamui-install/backend-upgrade-prepared.json').stat().st_mode & 0o777), '0o600')
        self.assertEqual(fake.services, {})
        self.assertEqual(fake.units[FENCE], 'active')

    def test_unfinished_recovery_is_refused_before_anything_stops(self):
        fake = self.host(); fake.jobs = (1, 1, 0)
        with self.assertRaises(host_program.Refused) as caught: host_program.upgrade_prepare_backend(fake.host, BOOT)
        self.assertEqual(caught.exception.code, 'RECOVERY_JOBS_UNFINISHED')
        self.assertFalse(any(c[0] == 'stop' for c in fake.calls))
        self.assertEqual(fake.units[STACK], 'active')

    def test_failed_backup_leaves_the_gate_open_and_writes_no_record(self):
        fake = self.host(); fake.backup_fails = 'full'
        with self.assertRaises(host_program.Refused) as caught: host_program.upgrade_prepare_backend(fake.host, BOOT)
        self.assertEqual(caught.exception.code, 'BACKUP_FULL_FAILED')
        self.assertEqual(sorted(caught.exception.detail['timersStopped']), sorted(TIMERS))
        self.assertEqual(fake.gate()['state'], 'ready')
        self.assertFalse((fake.root/'var/lib/kamui-install/backend-upgrade-prepared.json').exists())

    def test_without_a_current_fence_nothing_changes(self):
        fake = self.host(boot_fenced=False)
        with self.assertRaises(host_program.Refused) as caught: host_program.upgrade_prepare_backend(fake.host, BOOT)
        self.assertEqual(caught.exception.code, 'BOOT_FENCE_NOT_CURRENT_RUN_14_FENCE')
        self.assertEqual([c for c in fake.calls if c[0] in {'stop', 'backup'}], [])

    def test_another_boot_is_refused(self):
        fake = self.host()
        with self.assertRaises(host_program.Refused) as caught: host_program.upgrade_prepare_backend(fake.host, str(uuid.uuid4()))
        self.assertEqual(caught.exception.code, 'HOST_REBOOTED_SINCE_INSPECTION')

    def test_pepper_prepare_stops_the_stack_and_records(self):
        fake = self.host('pepper')
        self.assertEqual(host_program.upgrade_prepare_pepper(fake.host, BOOT)['status'], 'upgrade_prepared')
        self.assertEqual(fake.units['kamui@pepper.service'], 'inactive')
        self.assertEqual(fake.prepared()['role'], 'pepper')

    def test_finish_waits_for_reopen_then_restarts_the_backup_timers(self):
        fake = self.host()
        host_program.upgrade_prepare_backend(fake.host, BOOT)
        self.assertEqual(host_program.upgrade_finish(fake.host, 'backend'), {'status': 'awaiting_reopen', 'role': 'backend'})
        self.assertTrue(all(fake.units[t] == 'inactive' for t in TIMERS))
        fake.clock += 700
        quiet(host_program.reopen, fake.host, BOOT, fake.gate()['generation'], 'after-upgrade')
        result = host_program.upgrade_finish(fake.host, 'backend')
        self.assertEqual(result['status'], 'upgrade_finished')
        self.assertEqual(sorted(result['timersStarted']), sorted(TIMERS))
        self.assertEqual(host_program.upgrade_finish(fake.host, 'backend')['timersStarted'], [])

    def test_pepper_finish_starts_the_stack(self):
        fake = self.host('pepper')
        host_program.upgrade_prepare_pepper(fake.host, BOOT)
        self.assertEqual(host_program.upgrade_finish(fake.host, 'pepper')['status'], 'upgrade_finished')
        self.assertEqual(fake.units['kamui@pepper.service'], 'active')


class UpgradeCommands(test_host_install.FakeCommands):
    """Installer runner where some units are enabled-but-stopped and the boot fence is active."""
    def __init__(self, enabled=(), active=()):
        super().__init__(); self.enabled_units, self.active_units = set(enabled), set(active)

    def run(self, args, check=True):
        if args[:2] == ['systemctl', 'is-active'] and args[-1] in self.active_units:
            self.calls.append(args); return subprocess.CompletedProcess(args, 0, b'active\n', b'')
        if args[:2] == ['systemctl', 'is-enabled'] and args[-1] in self.enabled_units:
            self.calls.append(args); return subprocess.CompletedProcess(args, 0, b'enabled\n', b'')
        return super().run(args, check)


class InstallerUpgradeTest(test_host_install.HostInstallTest):
    """Reuses the installer fixture; only the upgrade-mode tests run here."""
    def started(self):
        root, manifest, options, commands, _ = self.fixture()
        host.install(**options)
        # The wallet ran: real data and a gate exist under the state directory.
        (root/'var/lib/kamui/postgres/PG_VERSION').write_text('16\n')
        generation = str(uuid.uuid4())
        (root/'var/lib/kamui/restore-gate/state.json').write_text(json.dumps({'version': 1, 'state': 'blocked', 'reason': 'restore',
                                                                              'generation': generation, 'changedAt': 1}))
        (root/'proc/sys/kernel/random').mkdir(parents=True); (root/'proc/sys/kernel/random/boot_id').write_text(BOOT+'\n')
        receipt = json.loads((root/'var/lib/kamui-install/backend.json').read_text())
        following, next_manifest = self.next_release(options, manifest)
        following['runner'] = UpgradeCommands(enabled={'kamui-backup-full.timer', 'kamui-backup-check.timer'}, active={FENCE})
        return root, receipt, generation, following, next_manifest

    def prepare(self, root, receipt, generation, **override):
        value = {'schema': 'kamui.upgrade-prepared.v1', 'role': 'backend', 'bootId': BOOT, 'preparedAt': 1_000_000,
                 'previousManifestSha256': receipt['manifestSha256'], 'backupLabel': LABEL, 'gateGeneration': generation, **override}
        path = root/'var/lib/kamui-install/backend-upgrade-prepared.json'
        path.write_text(json.dumps(value)); path.chmod(0o600)

    def test_prepared_started_wallet_upgrades_keeping_its_state_and_consuming_the_record(self):
        root, receipt, generation, following, next_manifest = self.started()
        self.prepare(root, receipt, generation)
        result = host.install(**following, upgrade_started=True, now=lambda: 1_000_100)
        self.assertEqual(result['status'], 'host_upgraded_wallet_stopped')
        self.assertEqual((root/'var/lib/kamui/postgres/PG_VERSION').read_text(), '16\n')
        self.assertEqual(json.loads((root/'var/lib/kamui/restore-gate/state.json').read_text())['generation'], generation)
        self.assertEqual(json.loads((root/'var/lib/kamui-install/backend.json').read_text())['archiveSha256'], next_manifest['archiveSha256'])
        self.assertFalse((root/'var/lib/kamui-install/backend-upgrade-prepared.json').exists())
        consumed = list((root/'var/lib/kamui-install').glob('backend-upgraded-*.json'))
        self.assertEqual(len(consumed), 1)
        self.assertEqual(json.loads(consumed[0].read_text())['backupLabel'], LABEL)
        self.assertFalse(any(c[:2] in (['systemctl', 'enable'], ['systemctl', 'start']) and 'kamui' in c[-1] for c in following['runner'].calls))

    def test_upgrade_refusals(self):
        cases = [
            ({}, None, 'UPGRADE_NOT_PREPARED_RUN_15_PREPARE'),
            ({'preparedAt': 1_000_000 - 7200}, 'record', 'UPGRADE_PREPARATION_STALE_RUN_15_PREPARE_AGAIN'),
            ({'bootId': str(uuid.uuid4())}, 'record', 'UPGRADE_PREPARED_BEFORE_A_REBOOT'),
            ({'previousManifestSha256': 'c'*64}, 'record', 'UPGRADE_PREPARED_FOR_ANOTHER_RELEASE'),
            ({'gateGeneration': str(uuid.uuid4())}, 'record', 'UPGRADE_REQUIRES_THE_GATE_BLOCKED_BY_PREPARE'),
            ({'extra': 1}, 'record', 'UPGRADE_PREPARATION_INVALID'),
        ]
        for override, record, error in cases:
            with self.subTest(error=error):
                root, receipt, generation, following, _ = self.started()
                if record: self.prepare(root, receipt, generation, **override)
                with self.assertRaisesRegex(ValueError, error): host.install(**following, upgrade_started=True, now=lambda: 1_000_000)
                self.assertEqual((root/'var/lib/kamui/postgres/PG_VERSION').read_text(), '16\n')

    def test_a_running_unit_still_refuses_and_plain_replacement_still_refuses_wallet_state(self):
        root, receipt, generation, following, _ = self.started()
        self.prepare(root, receipt, generation)
        running = {**following, 'runner': UpgradeCommands(active={FENCE, 'kamui@backend.service'})}
        with self.assertRaisesRegex(ValueError, 'EXISTING_KAMUI_UNIT_MUST_BE_STOPPED'): host.install(**running, upgrade_started=True, now=lambda: 1_000_000)
        with self.assertRaisesRegex(ValueError, 'EXISTING_WALLET_STATE_REQUIRES_REVIEWED_UPGRADE'): host.install(**following, replace_unstarted=True)
        with self.assertRaisesRegex(ValueError, 'INSTALL_MODE_CONFLICT'): host.install(**following, replace_unstarted=True, upgrade_started=True)

    def test_a_blocked_gate_alone_does_not_authorise_an_upgrade_without_the_record(self):
        root, receipt, generation, following, _ = self.started()
        with self.assertRaisesRegex(ValueError, 'UPGRADE_NOT_PREPARED'): host.install(**following, upgrade_started=True, now=lambda: 1_000_000)


# The installer fixture's own tests already run in test_host_install; skip them here.
for name in [n for n in dir(test_host_install.HostInstallTest) if n.startswith('test_')]:
    if not hasattr(InstallerUpgradeTest, name) or getattr(InstallerUpgradeTest, name) is getattr(test_host_install.HostInstallTest, name):
        setattr(InstallerUpgradeTest, name, None)


class WorkstationTest(unittest.TestCase):
    def tool(self, superseded=True, confirmation='UPGRADE', results=None):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve(); root.chmod(0o700)
        (root/'installation').mkdir(mode=0o700); (root/'installation/release').mkdir(mode=0o700)
        release = root/'installation/release/release.json'; release.write_text(json.dumps({'sourceRevision': 'd'*40})); release.chmod(0o600)
        if superseded:
            entry = root/('installation/superseded/005-'+'a'*12); entry.mkdir(parents=True, mode=0o700)
            (root/'installation/superseded').chmod(0o700)
            for name in ['superseded.json', 'complete.json']:
                (entry/name).write_text(json.dumps({'sourceRevision': 'a'*40})); (entry/name).chmod(0o600)
        calls, delivered = [], []
        tool = upgrade.Upgrade(root, driver=None, aws=None, deliver=lambda *a, **k: delivered.append(k) or {'publicPackageInstalled': True},
                               confirm=lambda prompt: confirmation, out=lambda *_: None)
        inspected = {'backend': {'bootId': BOOT, 'fence': 'current', 'fenceUnit': 'active', 'recoveryJobs': {'unfinished': 0}},
                     'pepper': {'bootId': BOOT}}
        tool.inspect = lambda role: inspected[role]
        tool.evidence = lambda *a: None
        def call(role, label, action, *args):
            calls.append((role, action) + args)
            return (results or {}).get((role, action), {'status': 'upgrade_prepared' if action == 'upgrade-prepare' else 'upgrade_finished', 'backupLabel': LABEL})
        tool.call = call
        return tool, calls, delivered, inspected

    def test_prepare_needs_a_superseded_and_built_release_and_a_typed_confirmation(self):
        tool, calls, _, _ = self.tool(superseded=False)
        with self.assertRaisesRegex(ValueError, 'UPGRADE_RUN_11_THEN_07_FIRST'): tool.prepare()
        tool, calls, _, _ = self.tool(confirmation='yes')
        with self.assertRaisesRegex(ValueError, 'UPGRADE_NOT_CONFIRMED'): tool.prepare()
        self.assertEqual(calls, [])

    def test_prepare_does_pepper_then_backend_with_the_inspected_boot(self):
        tool, calls, _, _ = self.tool()
        result = tool.prepare()
        self.assertEqual(calls, [('pepper', 'upgrade-prepare', 'pepper', BOOT), ('backend', 'upgrade-prepare', 'backend', BOOT)])
        self.assertEqual(result['status'], 'UPGRADE_PREPARED_RUN_15_INSTALL_WITHIN_ONE_HOUR')

    def test_prepare_refuses_unfinished_jobs_and_a_missing_fence_before_any_host_change(self):
        tool, calls, _, inspected = self.tool()
        inspected['backend']['recoveryJobs'] = {'unfinished': 2}
        with self.assertRaisesRegex(ValueError, 'UPGRADE_RECOVERY_JOBS_UNFINISHED'): tool.prepare()
        inspected['backend']['recoveryJobs'] = {'unfinished': 0}; inspected['backend']['fence'] = 'missing'
        with self.assertRaisesRegex(ValueError, 'UPGRADE_BOOT_FENCE_NOT_CURRENT'): tool.prepare()
        self.assertEqual(calls, [])

    def test_install_delivers_in_upgrade_mode_and_finish_reports_the_reopen_step(self):
        tool, calls, delivered, _ = self.tool(results={('backend', 'upgrade-finish'): {'status': 'awaiting_reopen'}})
        tool.install()
        self.assertEqual(delivered, [{'upgrade': True}])
        self.assertEqual(tool.finish()['status'], 'PEPPER_STARTED_RUN_14_REOPEN_THEN_15_FINISH_AGAIN')


class BootstrapTest(unittest.TestCase):
    def test_upgrade_flag_only_for_install_and_never_with_replace(self):
        install = test_reopen.load('install')
        artifact = {'path': 'fixture', 'sha256': 'a'*64}
        value = {'installer': artifact, 'puller': artifact, 'compose': artifact, 'roles': {'backend': {'archive': artifact, 'manifest': artifact}}}
        command = install.bootstrap('backend', 'fixture-release-bucket', value, upgrade=True)
        self.assertIn('--upgrade-started', command); self.assertNotIn('--replace-unstarted', command)
        subprocess.run(['sh', '-n'], input=command, text=True, capture_output=True, check=True)
        for kwargs in [{'verify': True, 'upgrade': True}, {'replace': True, 'upgrade': True}]:
            with self.assertRaises(ValueError): install.bootstrap('backend', 'fixture-release-bucket', value, **kwargs)


if __name__ == '__main__':
    unittest.main()
