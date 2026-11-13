"""Upgrading a started wallet: host actions, the installer's upgrade mode and the workstation steps.

Fake hosts, a fake installer runner and fake SSM calls only; no AWS, Docker, systemd or real host.
"""
import contextlib
import fcntl
import os
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid

import common
import test_host_install
import test_install
import test_reopen
from test_reopen import BOOT, BTIME, FENCE, STACK, FakeHost, host_program

host = test_host_install.host
TIMERS = host_program.TIMERS
LABEL = '20261113-140000F'
PREP = str(uuid.uuid4())
PEPPER_PREP = str(uuid.uuid4())


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
        self.no_fresh_backup = False
        self.down_leaves = None

    def prepared(self): return json.loads((self.root/'var/lib/kamui-install'/(self.role+'-upgrade-prepared.json')).read_text())

    def run(self, args):
        if args[:3] == ['python3', '-B', '-c']:
            self.calls.append(('legacy-shim', Path(args[4]).name)); args = args[:2] + args[4:]
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
            if kind == 'full' and not self.no_fresh_backup: self.backups.append({'type': 'full', 'label': LABEL, 'timestamp': {'stop': int(self.clock)}})
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
            self.calls.append(('host.py', args[3], 'down')); self.services = self.down_leaves or {}; return 0, '', ''
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
        self.assertEqual(record, {'schema': 'kamui.upgrade-prepared.v1', 'role': 'backend', 'prepareId': result['prepareId'], 'bootId': BOOT,
                                  'preparedAt': int(fake.clock), 'previousManifestSha256': 'a'*64, 'backupLabel': LABEL,
                                  'gateGeneration': gate['generation']})
        self.assertNotEqual(host_program.upgrade_prepare_backend(self.host().host, BOOT)['prepareId'], result['prepareId'])
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

    def test_a_running_backup_refuses_and_restarts_the_timers_it_stopped(self):
        fake = self.host(); fake.units['kamui-backup@full.service'] = 'activating'
        with self.assertRaises(host_program.Refused) as caught: host_program.upgrade_prepare_backend(fake.host, BOOT)
        self.assertEqual(caught.exception.code, 'BACKUP_IN_PROGRESS_RETRY_LATER')
        self.assertTrue(all(fake.units[t] == 'active' for t in TIMERS))
        self.assertEqual(fake.units[STACK], 'active')

    def test_an_older_backup_never_counts_as_the_rollback_point(self):
        fake = self.host(); fake.no_fresh_backup = True
        with self.assertRaises(host_program.Refused) as caught: host_program.upgrade_prepare_backend(fake.host, BOOT)
        self.assertEqual(caught.exception.code, 'FRESH_BACKUP_NOT_FOUND')
        self.assertEqual(fake.gate()['state'], 'ready')

    def test_containers_left_running_after_down_refuse_the_record(self):
        fake = self.host(); fake.down_leaves = {'watcher': ('running', '')}
        with self.assertRaises(host_program.Refused) as caught: host_program.upgrade_prepare_backend(fake.host, BOOT)
        self.assertEqual(caught.exception.code, 'CONTAINERS_STILL_RUNNING')
        self.assertFalse((fake.root/'var/lib/kamui-install/backend-upgrade-prepared.json').exists())

    def test_an_unexpected_failure_still_reports_the_timers_it_stopped(self):
        fake = self.host()
        original = fake.run
        def broken(args):
            if args[:2] == ['bash', '-c']: raise RuntimeError('boom')
            return original(args)
        fake.host.run = broken
        with self.assertRaises(host_program.Refused) as caught: host_program.upgrade_prepare_backend(fake.host, BOOT)
        self.assertEqual(caught.exception.code, 'PREPARE_FAILED')
        self.assertEqual(sorted(caught.exception.detail['timersStopped']), sorted(TIMERS))

    def test_finish_restarts_a_backend_whose_gate_was_never_blocked(self):
        fake = self.host(); fake.backup_fails = 'full'
        with self.assertRaises(host_program.Refused): host_program.upgrade_prepare_backend(fake.host, BOOT)
        self.assertNotEqual(fake.units[STACK], 'active')
        result = host_program.upgrade_finish(fake.host, 'backend')
        self.assertEqual(result['status'], 'upgrade_finished')
        self.assertEqual(fake.units[STACK], 'active')
        self.assertEqual(sorted(result['timersStarted']), sorted(TIMERS))

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

    def test_the_control_lock_is_held_from_the_writer_check_to_the_record(self, inherits=True):
        fake = self.host()
        if inherits:
            script = fake.root/'opt/kamui/lean/scripts/host.py'; script.parent.mkdir(parents=True, exist_ok=True)
            script.write_text("HELD_LOCK = '"+host_program.HELD_LOCK+"'\n")
        lock = fake.root/'var/lib/kamui/.operator.lock'
        seen = []
        original = fake.run
        def observe(args):
            if args[:2] == ['bash', '-c'] or (args[:2] == ['python3', '-B'] and args[-3].endswith('/wallet-control.py')):
                other = os.open(lock, os.O_WRONLY)
                try: fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB); seen.append('free')
                except BlockingIOError: seen.append('held')
                finally: os.close(other)
                seen.append(os.environ.get(host_program.HELD_LOCK) is not None)
            return original(args)
        fake.host.run = observe
        host_program.upgrade_prepare_backend(fake.host, BOOT)
        # Backup, check, block: always under the lock, whichever release is installed.
        self.assertEqual(seen, ['held', True]*3)
        shimmed = [c[1] for c in fake.calls if c[0] == 'legacy-shim']
        self.assertEqual(shimmed, [] if inherits else ['host.py', 'wallet-control.py', 'host.py'])
        self.assertNotIn(host_program.HELD_LOCK, os.environ)
        other = os.open(lock, os.O_WRONLY)
        try: fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally: os.close(other)

    def test_an_older_installed_release_hands_the_lock_over_only_for_its_own_calls(self):
        self.test_the_control_lock_is_held_from_the_writer_check_to_the_record(inherits=False)

    def test_the_legacy_shim_runs_an_old_wrapper_under_the_held_lock(self):
        """Real processes: an old-style wrapper that takes the lock itself, run with the lock held."""
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        state = Path(temporary.name).resolve(); state.chmod(0o700)
        legacy = state/'host.py'
        legacy.write_text("""import fcntl, os, sys
from contextlib import contextmanager
from pathlib import Path
@contextmanager
def control_lock(state):
    fd = os.open(Path(state)/'.operator.lock', os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); yield
    finally: os.close(fd)
def main():
    with control_lock(Path(sys.argv[1])): print('ran', sys.argv[2])
""")
        fd = os.open(state/'.operator.lock', os.O_CREAT | os.O_WRONLY, 0o600); self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        env = {**os.environ, host_program.HELD_LOCK: str(fd)}
        direct = subprocess.run(['python3', '-B', '-c', 'import runpy,sys; m=runpy.run_path(sys.argv[1]); sys.argv=sys.argv[1:]; m["main"]()', str(legacy), str(state), 'x'],
                                capture_output=True, text=True, env=env, pass_fds=(fd,))
        self.assertNotEqual(direct.returncode, 0)  # the old wrapper alone cannot take a held lock
        shimmed = subprocess.run(['python3', '-B', '-c', host_program.LEGACY_SHIM, str(legacy), str(state), 'prepare'],
                                 capture_output=True, text=True, env=env, pass_fds=(fd,))
        self.assertEqual((shimmed.returncode, shimmed.stdout), (0, 'ran prepare\n'))
        # A descriptor that does not hold the lock is still refused.
        other = os.open(state/'.operator.lock', os.O_WRONLY); self.addCleanup(os.close, other)
        refused = subprocess.run(['python3', '-B', '-c', host_program.LEGACY_SHIM, str(legacy), str(state), 'prepare'],
                                 capture_output=True, text=True, env={**os.environ, host_program.HELD_LOCK: str(other)}, pass_fds=(other,))
        self.assertNotEqual(refused.returncode, 0)

    def test_a_busy_control_lock_refuses_before_the_backup(self):
        fake = self.host()
        lock = fake.root/'var/lib/kamui/.operator.lock'
        other = os.open(lock, os.O_CREAT | os.O_WRONLY, 0o600); self.addCleanup(os.close, other)
        fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with self.assertRaises(host_program.Refused) as caught: host_program.upgrade_prepare_backend(fake.host, BOOT)
        self.assertEqual(caught.exception.code, 'HOST_CONTROL_BUSY')
        self.assertFalse(any(c[0] == 'backup' for c in fake.calls))
        self.assertEqual(fake.gate()['state'], 'ready')

    def test_finish_restores_exactly_the_timers_prepare_stopped_across_a_retry(self):
        fake = self.host()
        fake.enabled['kamui-backup-check.timer'] = 'disabled'   # active but not enabled: still restored
        fake.units['kamui-backup-full.timer'] = 'inactive'      # enabled but stopped by the operator: left alone
        fake.backup_fails = 'full'
        with self.assertRaises(host_program.Refused): host_program.upgrade_prepare_backend(fake.host, BOOT)
        fake.backup_fails = None
        # The retry finds no active timer, yet still remembers the one the first attempt stopped.
        result = host_program.upgrade_prepare_backend(fake.host, BOOT)
        self.assertEqual(result['timersStopped'], [])
        fake.clock += 700
        quiet(host_program.reopen, fake.host, BOOT, fake.gate()['generation'], 'after-upgrade')
        self.assertEqual(host_program.upgrade_finish(fake.host, 'backend')['timersStarted'], ['kamui-backup-check.timer'])
        self.assertEqual(fake.units['kamui-backup-full.timer'], 'inactive')
        self.assertFalse((fake.root/'var/lib/kamui-install/backend-upgrade-timers.json').exists())

    def test_prepare_and_finish_never_overlap_on_the_host(self):
        fake = self.host()
        lock = fake.root/'var/lib/kamui-install/.upgrade-step.lock'
        other = os.open(lock, os.O_CREAT | os.O_WRONLY, 0o600); self.addCleanup(os.close, other)
        fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with self.assertRaises(host_program.Refused) as caught: host_program.upgrade_finish(fake.host, 'backend')
        self.assertEqual(caught.exception.code, 'UPGRADE_STEP_BUSY')
        with self.assertRaises(host_program.Refused) as caught: host_program.upgrade_prepare_backend(fake.host, BOOT)
        self.assertEqual(caught.exception.code, 'UPGRADE_STEP_BUSY')
        self.assertTrue(all(fake.units[t] == 'active' for t in TIMERS))
        self.assertFalse((fake.root/'var/lib/kamui-install/backend-upgrade-timers.json').exists())

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
        value = {'schema': 'kamui.upgrade-prepared.v1', 'role': 'backend', 'prepareId': PREP, 'bootId': BOOT, 'preparedAt': 1_000_000,
                 'previousManifestSha256': receipt['manifestSha256'], 'backupLabel': LABEL, 'gateGeneration': generation, **override}
        path = root/'var/lib/kamui-install/backend-upgrade-prepared.json'
        path.write_text(json.dumps(value)); path.chmod(0o600)

    def test_prepared_started_wallet_upgrades_keeping_its_state_and_consuming_the_record(self):
        root, receipt, generation, following, next_manifest = self.started()
        self.prepare(root, receipt, generation)
        result = host.install(**following, upgrade_started=PREP, now=lambda: 1_000_100)
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
            ({'prepareId': str(uuid.uuid4())}, 'record', 'UPGRADE_PREPARED_BY_ANOTHER_RUN_RERUN_15_PREPARE'),
        ]
        for override, record, error in cases:
            with self.subTest(error=error):
                root, receipt, generation, following, _ = self.started()
                if record: self.prepare(root, receipt, generation, **override)
                with self.assertRaisesRegex(ValueError, error): host.install(**following, upgrade_started=PREP, now=lambda: 1_000_000)
                self.assertEqual((root/'var/lib/kamui/postgres/PG_VERSION').read_text(), '16\n')

    def test_a_running_unit_still_refuses_and_plain_replacement_still_refuses_wallet_state(self):
        root, receipt, generation, following, _ = self.started()
        self.prepare(root, receipt, generation)
        running = {**following, 'runner': UpgradeCommands(active={FENCE, 'kamui@backend.service'})}
        with self.assertRaisesRegex(ValueError, 'EXISTING_KAMUI_UNIT_MUST_BE_STOPPED'): host.install(**running, upgrade_started=PREP, now=lambda: 1_000_000)
        with self.assertRaisesRegex(ValueError, 'EXISTING_WALLET_STATE_REQUIRES_REVIEWED_UPGRADE'): host.install(**following, replace_unstarted=True)
        with self.assertRaisesRegex(ValueError, 'INSTALL_MODE_CONFLICT'): host.install(**following, replace_unstarted=True, upgrade_started=PREP)

    def test_an_open_gate_with_the_recorded_generation_still_refuses(self):
        root, receipt, generation, following, _ = self.started()
        self.prepare(root, receipt, generation)
        gate = root/'var/lib/kamui/restore-gate/state.json'
        gate.write_text(json.dumps({**json.loads(gate.read_text()), 'state': 'ready', 'mode': 'restored'}))
        with self.assertRaisesRegex(ValueError, 'UPGRADE_REQUIRES_THE_GATE_BLOCKED_BY_PREPARE'): host.install(**following, upgrade_started=PREP, now=lambda: 1_000_000)

    def test_a_refused_unit_check_changes_nothing_visible(self):
        root, receipt, generation, following, _ = self.started()
        self.prepare(root, receipt, generation)
        link_before = (root/'opt/kamui/lean').resolve()
        env_before = (root/'etc/kamui/release.env').read_bytes()
        unit = root/'etc/systemd/system/kamui@.service'; unit.write_bytes(unit.read_bytes()+b'\n# local edit\n')
        with self.assertRaisesRegex(ValueError, 'INSTALLED_FILE_CHANGED_REFUSE_REPLACE'): host.install(**following, upgrade_started=PREP, now=lambda: 1_000_000)
        self.assertEqual((root/'opt/kamui/lean').resolve(), link_before)
        self.assertEqual((root/'etc/kamui/release.env').read_bytes(), env_before)
        self.assertEqual(list((root/'var/lib/kamui-install').glob('backend-superseded-*.json')), [])
        self.assertTrue((root/'var/lib/kamui-install/backend-upgrade-prepared.json').exists())

    def test_upgrading_to_the_same_release_twice_records_each_upgrade(self):
        root, receipt, generation, following, next_manifest = self.started()
        self.prepare(root, receipt, generation)
        host.install(**following, upgrade_started=PREP, now=lambda: 1_000_000)
        # Back to the original release, then forward again with a new preparation each time.
        original = {**following, 'archive_path': following['archive_path'].parent/'package.tar.gz',
                    'manifest_path': following['manifest_path'].parent/'manifest.json'}
        original['expected_manifest'] = host.sha(original['manifest_path'].read_bytes())
        for options in [original, following]:
            current = json.loads((root/'var/lib/kamui-install/backend.json').read_text())
            prep = str(uuid.uuid4())
            self.prepare(root, current, generation, prepareId=prep)
            self.assertEqual(host.install(**options, upgrade_started=prep, now=lambda: 1_000_000)['status'], 'host_upgraded_wallet_stopped')
        self.assertEqual(len(list((root/'var/lib/kamui-install').glob('backend-upgraded-*.json'))), 3)

    def test_a_receipt_in_another_valid_formatting_is_replaced_and_updated(self):
        root, receipt, generation, following, next_manifest = self.started()
        path = root/'var/lib/kamui-install/backend.json'
        path.write_text(json.dumps(receipt, indent=2)+'\n')   # same content, not the canonical bytes
        self.prepare(root, receipt, generation)
        self.assertEqual(host.install(**following, upgrade_started=PREP, now=lambda: 1_000_000)['status'], 'host_upgraded_wallet_stopped')
        self.assertEqual(json.loads(path.read_text())['archiveSha256'], next_manifest['archiveSha256'])

    def test_read_only_monitor_timers_may_keep_running(self):
        root, receipt, generation, following, _ = self.started()
        self.prepare(root, receipt, generation)
        following['runner'] = UpgradeCommands(active={FENCE, 'kamui-monitor@backend.timer'})
        self.assertEqual(host.install(**following, upgrade_started=PREP, now=lambda: 1_000_000)['status'], 'host_upgraded_wallet_stopped')

    def test_a_held_control_lock_refuses_and_changes_nothing(self):
        root, receipt, generation, following, _ = self.started()
        self.prepare(root, receipt, generation)
        link_before = (root/'opt/kamui/lean').resolve()
        other = os.open(root/'var/lib/kamui/.operator.lock', os.O_CREAT | os.O_WRONLY, 0o600); self.addCleanup(os.close, other)
        fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with self.assertRaisesRegex(ValueError, 'HOST_CONTROL_BUSY'): host.install(**following, upgrade_started=PREP, now=lambda: 1_000_000)
        self.assertEqual((root/'opt/kamui/lean').resolve(), link_before)
        self.assertTrue((root/'var/lib/kamui-install/backend-upgrade-prepared.json').exists())

    def test_the_control_lock_is_held_while_replacing(self):
        root, receipt, generation, following, _ = self.started()
        self.prepare(root, receipt, generation)
        lock, seen = root/'var/lib/kamui/.operator.lock', []
        runner = following['runner']; original = runner.run
        def observe(args, check=True):
            if args == ['systemctl', 'daemon-reload']:
                other = os.open(lock, os.O_WRONLY)
                try: fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB); seen.append('free')
                except BlockingIOError: seen.append('held')
                finally: os.close(other)
            return original(args, check)
        runner.run = observe
        host.install(**following, upgrade_started=PREP, now=lambda: 1_000_000)
        self.assertEqual(seen, ['held'])

    def test_a_blocked_gate_alone_does_not_authorise_an_upgrade_without_the_record(self):
        root, receipt, generation, following, _ = self.started()
        with self.assertRaisesRegex(ValueError, 'UPGRADE_NOT_PREPARED'): host.install(**following, upgrade_started=PREP, now=lambda: 1_000_000)


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
            return (results or {}).get((role, action), {'status': 'upgrade_prepared' if action == 'upgrade-prepare' else 'upgrade_finished',
                                                        'backupLabel': LABEL, 'prepareId': PREP if role == 'backend' else PEPPER_PREP})
        tool.call = call
        return tool, calls, delivered, inspected

    def test_prepare_needs_a_superseded_and_built_release_and_a_typed_confirmation(self):
        tool, calls, _, _ = self.tool(superseded=False)
        with self.assertRaisesRegex(ValueError, 'UPGRADE_RUN_11_THEN_07_FIRST'): tool.prepare()
        tool, calls, _, _ = self.tool(confirmation='yes')
        with self.assertRaisesRegex(ValueError, 'UPGRADE_NOT_CONFIRMED'): tool.prepare()
        self.assertEqual(calls, [])

    def test_prepare_does_backend_then_pepper_and_records_both_ids(self):
        tool, calls, _, _ = self.tool()
        result = tool.prepare()
        self.assertEqual(calls, [('backend', 'upgrade-prepare', 'backend', BOOT), ('pepper', 'upgrade-prepare', 'pepper', BOOT)])
        self.assertEqual(json.loads(tool.prepared_path.read_text())['prepareIds'], {'backend': PREP, 'pepper': PEPPER_PREP})
        self.assertEqual(result['status'], 'UPGRADE_PREPARED_RUN_15_INSTALL_WITHIN_ONE_HOUR')

    def test_prepare_refuses_unfinished_jobs_and_a_missing_fence_before_any_host_change(self):
        tool, calls, _, inspected = self.tool()
        inspected['backend']['recoveryJobs'] = {'unfinished': 2}
        with self.assertRaisesRegex(ValueError, 'UPGRADE_RECOVERY_JOBS_UNFINISHED'): tool.prepare()
        inspected['backend']['recoveryJobs'] = {'unfinished': 0}; inspected['backend']['fence'] = 'missing'
        with self.assertRaisesRegex(ValueError, 'UPGRADE_BOOT_FENCE_NOT_CURRENT'): tool.prepare()
        self.assertEqual(calls, [])

    def test_a_refused_backend_prepare_never_touches_pepper(self):
        tool, calls, _, _ = self.tool(results={('backend', 'upgrade-prepare'): {'status': 'refused', 'code': 'BACKUP_FULL_FAILED'}})
        with self.assertRaisesRegex(ValueError, 'UPGRADE_PREPARE_BACKEND_BACKUP_FULL_FAILED'): tool.prepare()
        self.assertEqual([c[0] for c in calls], ['backend'])
        self.assertFalse(tool.prepared_path.exists())

    def test_install_needs_this_runs_preparation_and_delivers_its_ids(self):
        tool, calls, delivered, _ = self.tool(results={('backend', 'upgrade-finish'): {'status': 'awaiting_reopen'}})
        with self.assertRaisesRegex(ValueError, 'UPGRADE_NOT_PREPARED_RUN_15_PREPARE'): tool.install()
        tool.prepare()
        tool.install()
        self.assertEqual(delivered, [{'upgrade': {'backend': PREP, 'pepper': PEPPER_PREP}}])
        self.assertEqual(tool.finish()['status'], 'PEPPER_STARTED_RUN_14_REOPEN_THEN_15_FINISH_AGAIN')


class HostControlLockTest(unittest.TestCase):
    """scripts/host.py accepts the lock only from the process tree that holds it."""
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name).resolve(); self.state.chmod(0o700)
        spec = importlib.util.spec_from_file_location('upgrade_test_hostpy', Path(__file__).parents[1]/'scripts/host.py')
        self.hostpy = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.hostpy)
        self.addCleanup(os.environ.pop, self.hostpy.HELD_LOCK, None)

    def held(self):
        fd = os.open(self.state/'.operator.lock', os.O_CREAT | os.O_WRONLY, 0o600); self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); return fd

    def test_the_holder_passes_it_down_and_nobody_else_can_take_it(self):
        fd = self.held()
        with self.assertRaisesRegex(ValueError, 'HOST_CONTROL_BUSY'):
            with self.hostpy.control_lock(self.state): pass
        os.environ[self.hostpy.HELD_LOCK] = str(fd)
        with self.hostpy.control_lock(self.state): pass

    def test_an_unrelated_or_unheld_descriptor_is_refused(self):
        self.held()
        other = os.open(self.state/'.operator.lock', os.O_WRONLY); self.addCleanup(os.close, other)
        os.environ[self.hostpy.HELD_LOCK] = str(other)
        with self.assertRaisesRegex(ValueError, 'HOST_CONTROL_BUSY'):
            with self.hostpy.control_lock(self.state): pass
        unrelated = os.open(self.state/'other', os.O_CREAT | os.O_WRONLY, 0o600); self.addCleanup(os.close, unrelated)
        os.environ[self.hostpy.HELD_LOCK] = str(unrelated)
        with self.assertRaisesRegex(ValueError, 'HOST_CONTROL_LOCK_INVALID'):
            with self.hostpy.control_lock(self.state): pass


class DriverUpgradeTest(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        return test_install.InstallationTest.fixture(self, temporary.name)

    def test_preparation_gets_the_backup_budget_and_other_commands_keep_theirs(self):
        _, aws, driver = self.fixture()
        driver.command('backend', 'upgrade-prepare', 'i-0123456789abcdef0', 'prepare')
        driver.command('backend', 'upgrade-finish', 'i-0123456789abcdef0', 'finish')
        sent = [c[3]['Parameters']['executionTimeout'] for c in aws.calls if c[2] == 'send-command']
        self.assertEqual(sent, [['7200'], ['1800']])

    def test_a_failed_pull_is_sent_again_while_the_install_only_reconciles(self):
        _, aws, driver = self.fixture()
        answer, failures = aws.request, ['Failed']
        def request(profile, service, operation, inputs):
            reply = answer(profile, service, operation, inputs)
            if operation == 'get-command-invocation' and failures and self.pulling: reply = {**reply, 'Status': failures.pop()}
            return reply
        aws.request = request
        self.pulling = False
        driver.command('backend', 'install', 'i-0123456789abcdef0', 'package')
        self.pulling = True
        with self.assertRaisesRegex(ValueError, 'INSTALL_COMMAND_FAILED'): driver.command('backend', 'pull', 'i-0123456789abcdef0', 'images')
        driver.command('backend', 'install', 'i-0123456789abcdef0', 'package')
        driver.command('backend', 'pull', 'i-0123456789abcdef0', 'images')
        comments = [c[3]['Comment'] for c in aws.calls if c[2] == 'send-command']
        self.assertEqual([c.split('-')[1] for c in comments], ['install', 'pull', 'pull'])


class DeliverUpgradeTest(unittest.TestCase):
    def test_each_host_installs_its_package_then_pulls_in_a_separate_command(self):
        install = test_reopen.load('install')
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        root = Path(temporary.name); (root/'installation/release').mkdir(parents=True, mode=0o700)
        common.write_private(root/'installation/release/release.json', {'releaseBucketName': 'fixture-release-bucket'})
        artifact = {'path': str(root/'fixture'), 'sha256': 'a'*64}
        roles = {role: {'archive': artifact, 'manifest': artifact} for role in ['backend', 'pepper']}
        install.package = lambda root, manifest: {'installer': artifact, 'puller': artifact, 'compose': artifact, 'roles': roles}
        sent = []
        class Driver:
            config = {'backend': {'aws_profile': 'p', 'expected_account': '1'}}
            def target(self, role): return {'InstanceId': 'i-0123456789abcdef0'}
            def command(self, role, label, instance, command): sent.append((role, label, command))
        class Aws:
            def put_public_file(self, *args): pass
        install.deliver(root, Aws(), Driver(), upgrade={'backend': PREP, 'pepper': PEPPER_PREP})
        self.assertEqual([(r, l) for r, l, _ in sent], [('backend', 'install'), ('backend', 'pull'), ('pepper', 'install'), ('pepper', 'pull')])
        package, images = sent[0][2], sent[1][2]
        self.assertIn('--upgrade-started '+PREP, package); self.assertNotIn('pull-images.py" --role', package)
        self.assertIn('--check', images.split('python3 "$work/pull-images.py"')[0]); self.assertNotIn('--upgrade-started', images)
        self.assertIn('pull-images.py" --role', images); self.assertNotIn('docker-auth" --check', images)
        self.assertIn('--upgrade-started '+PEPPER_PREP, sent[2][2])


class FixedCodeTest(unittest.TestCase):
    def test_codes_naming_a_script_number_reach_the_operator(self):
        reopen = test_reopen.load('reopen')
        line = host_program.RESULT+json.dumps({'status': 'refused', 'code': 'BOOT_FENCE_NOT_CURRENT_RUN_14_FENCE'})
        self.assertEqual(reopen.parse(line)['code'], 'BOOT_FENCE_NOT_CURRENT_RUN_14_FENCE')
        for name in ['upgrade.py', 'install.py', 'reopen.py', 'host_install.py']:
            self.assertIn("'[A-Z0-9_]{3,100}'", (Path(__file__).parent/name).read_text(), name)


class BootstrapTest(unittest.TestCase):
    def test_upgrade_flag_only_for_install_and_never_with_replace(self):
        install = test_reopen.load('install')
        artifact = {'path': 'fixture', 'sha256': 'a'*64}
        value = {'installer': artifact, 'puller': artifact, 'compose': artifact, 'roles': {'backend': {'archive': artifact, 'manifest': artifact}}}
        command = install.bootstrap('backend', 'fixture-release-bucket', value, upgrade=PREP)
        self.assertIn('--upgrade-started '+PREP, command)
        self.assertIn('--upgrade-started', command); self.assertNotIn('--replace-unstarted', command)
        subprocess.run(['sh', '-n'], input=command, text=True, capture_output=True, check=True)
        for kwargs in [{'verify': True, 'upgrade': PREP}, {'replace': True, 'upgrade': PREP}, {'upgrade': 'not-an-id; rm -rf /'}]:
            with self.assertRaises(ValueError): install.bootstrap('backend', 'fixture-release-bucket', value, **kwargs)


if __name__ == '__main__':
    unittest.main()
