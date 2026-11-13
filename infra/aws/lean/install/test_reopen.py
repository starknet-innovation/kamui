"""Reboot reopen tooling. Fake hosts and a fake SSM driver; no AWS, Docker, systemd or real host."""
import ast
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest
import uuid

import common
import test_install


def load(name):
    spec = importlib.util.spec_from_file_location('reopen_test_'+name, Path(__file__).parent/(name+'.py'))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


host_program = load('reopen_host')
reopen = load('reopen')
FENCE, STACK = host_program.FENCE, host_program.STACK
BTIME = 1_800_000_000
BOOT = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'


class FakeHost:
    """A small model of one host: files under a temp root plus systemd/compose/wallet-control."""
    def __init__(self, root, role='backend', boot_fenced=True, now=BTIME+60):
        self.root, self.role, self.clock = Path(root), role, now
        self.calls = []
        self.units = {STACK: 'inactive', FENCE: 'inactive', 'kamui@pepper.service': 'inactive'}
        self.enabled = {STACK: 'disabled', 'kamui@pepper.service': 'disabled'}
        self.services = {}
        self.jobs = (0, 0, 0)
        self.wallet_refusal = None
        self.start_fails = False
        for path in ['proc/sys/kernel/random', 'run/kamui', 'var/lib/kamui/restore-gate', 'etc/systemd/system/multi-user.target.wants']:
            (self.root/path).mkdir(parents=True, exist_ok=True)
        (self.root/'etc/kamui/operator').mkdir(parents=True, mode=0o700)
        (self.root/'proc/sys/kernel/random/boot_id').write_text(BOOT+'\n')
        (self.root/'proc/stat').write_text('cpu 1 2 3\nbtime %d\nprocesses 9\n' % BTIME)
        if role == 'pepper':
            self.units['kamui@pepper.service'] = 'active'
            self.services = {'caddy': ('running', ''), 'pepper': ('running', 'healthy')}
        else:
            self.write_gate({'version': 1, 'state': 'ready', 'reason': 'restore', 'generation': str(uuid.uuid4()),
                             'changedAt': (BTIME-3600)*1000, 'mode': 'restored', 'reviewRef': 'before-boot'})
            if boot_fenced: self.fence_now(BTIME+20)
        self.host = host_program.Host(self.root, self.run, lambda: self.clock)

    # --- state helpers
    def gate_path(self): return self.root/'var/lib/kamui/restore-gate/state.json'
    def gate(self): return json.loads(self.gate_path().read_text())
    def write_gate(self, value): self.gate_path().write_text(json.dumps(value)+'\n')

    def fence_now(self, at):
        self.write_gate({'version': 1, 'state': 'blocked', 'reason': 'restore', 'generation': str(uuid.uuid4()), 'changedAt': at*1000})
        (self.root/'run/kamui/boot-fenced').write_text(BOOT+'\n')
        self.units[FENCE] = 'active'

    def boot_failed_stack(self):
        """What an enabled kamui@backend leaves after boot: API exited under the blocked gate."""
        self.units[STACK] = 'failed'
        self.services = {'postgres': ('running', 'healthy'), 'api': ('exited', ''), 'keychain': ('running', 'healthy'),
                         'caddy': ('running', ''), 'watcher': ('running', '')}

    def writers_running(self): return any(n in {'api', 'rotator'} and s[0] not in {'exited', 'dead', 'created'} for n, s in self.services.items())

    def kinds(self): return list(self.calls)

    # --- the command surface used by reopen_host.Host
    def run(self, args):
        if args[:2] == ['systemctl', 'is-active']:
            state = self.units.get(args[2], 'inactive'); return (0 if state == 'active' else 3), state+'\n', ''
        if args[:2] == ['systemctl', 'is-enabled']:
            state = self.enabled.get(args[2], 'static'); return (0 if state in {'enabled', 'static'} else 1), state+'\n', ''
        if args[:2] == ['python3', '-B'] and args[2].endswith('/host.py') and args[4] == 'status':
            return 0, json.dumps([{'service': n, 'state': s, 'health': h} for n, (s, h) in sorted(self.services.items())]), ''
        if args[:3] == ['docker', 'compose', '--env-file'] and 'psql' in args:
            self.calls.append(('psql',))
            if args[-1] == host_program.JOBS_TABLE: return 0, 't\n', ''
            return 0, '|'.join(str(x) for x in self.jobs)+'\n', ''
        self.calls.append(tuple([args[1]] + args[2:3]) if args[0] == 'systemctl' else (Path(args[2]).name,) + tuple(args[3:]))
        if args[:2] == ['systemctl', 'stop'] and args[2] == STACK:
            self.units[STACK] = 'inactive'; self.services = {}; return 0, '', ''
        if args[:2] == ['systemctl', 'start'] and args[2] == FENCE:
            self.fence_now(self.clock); return 0, '', ''
        if args[:2] == ['systemctl', 'start'] and args[2] == STACK:
            if self.units[FENCE] != 'active': self.fence_now(self.clock)
            if self.start_fails or self.gate()['state'] != 'ready':
                self.units[STACK] = 'failed'; self.services['api'] = ('exited', ''); return 1, '', ''
            self.units[STACK] = 'active'
            self.services = {'postgres': ('running', 'healthy'), 'api': ('running', 'healthy'), 'keychain': ('running', 'healthy'),
                             'caddy': ('running', ''), 'watcher': ('running', '')}
            return 0, '', ''
        if args[:2] == ['systemctl', 'enable']:
            self.enabled[args[2]] = 'enabled'; return 0, 'Created symlink.\n', ''
        if args[:2] == ['systemctl', 'add-wants']:
            os.symlink('/etc/systemd/system/'+args[3], self.root/'etc/systemd/system/multi-user.target.wants'/args[3]); return 0, '', ''
        if args[2].endswith('/host.py') and args[3:] == ['backend', 'prepare']:
            if self.writers_running(): return 1, '', '{"ok": false, "error": "STOP_OLD_WRITERS_REQUIRED"}'
            self.services['postgres'] = ('running', 'healthy'); return 0, '', ''
        if args[2].endswith('/wallet-control.py') and args[3:5] == ['restore', 'acknowledge']:
            return self.acknowledge(args[5])
        raise AssertionError('unexpected host command '+repr(args))

    def acknowledge(self, name):
        """Mirror of restore-fence.ts acknowledgeRestoreGate plus wallet-control's stopped-writer check."""
        def refuse(code): return 1, '', json.dumps({'status': 'refused', 'error': code})+'\n'
        if self.wallet_refusal: return refuse(self.wallet_refusal)
        if self.writers_running(): return refuse('STOP_OLD_WRITERS_REQUIRED')
        ack = json.loads((self.root/'etc/kamui/operator'/name).read_text())
        gate = self.gate()
        if gate['state'] != 'blocked' or ack['generation'] != gate['generation'] or ack['mode'] != 'restored': return refuse('RESTORE_ACKNOWLEDGEMENT_INVALID')
        if not all(ack[k] is True for k in ['apiAndRotatorStopped', 'originalWriterCannotRestart', 'signerHistoryReconciled', 'uncertainIntentsRetained', 'replayAndBudgetsConservative']):
            return refuse('RESTORE_RECONCILIATION_REQUIRED')
        if self.clock*1000 - gate['changedAt'] < 600_000: return refuse('RESTORE_REPLAY_WINDOW_ACTIVE')
        self.write_gate({'version': 1, 'state': 'ready', 'reason': gate['reason'], 'generation': gate['generation'],
                         'changedAt': int(self.clock*1000), 'mode': 'restored', 'reviewRef': ack['reviewRef']})
        return 0, json.dumps({'status': 'ready', 'mode': 'restored'})+'\n', ''


def quiet(function, *args):
    with contextlib.redirect_stdout(io.StringIO()): return function(*args)


class HostProgramTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def backend(self, **kwargs): return FakeHost(self.root, **kwargs)

    def reopen(self, fake, ref='review/2026-11-13'):
        return host_program.reopen(fake.host, BOOT, fake.gate()['generation'], ref)

    def test_reopen_after_boot_checks_jobs_then_acknowledges_then_starts(self):
        fake = self.backend(now=BTIME+20+640); fake.boot_failed_stack()
        generation = fake.gate()['generation']
        result = self.reopen(fake)
        self.assertEqual(result['status'], 'reopened')
        self.assertEqual(result['recoveryJobs'], {'unfinished': 0, 'withIntent': 0, 'reconciling': 0})
        gate = fake.gate()
        self.assertEqual((gate['state'], gate['mode'], gate['generation'], gate['reviewRef']), ('ready', 'restored', generation, 'review/2026-11-13'))
        self.assertEqual(fake.units[STACK], 'active')
        ack = json.loads((fake.root/'etc/kamui/operator'/('reboot-ack-'+generation+'.json')).read_text())
        self.assertEqual(ack['mode'], 'restored'); self.assertTrue(ack['signerHistoryReconciled'] and ack['apiAndRotatorStopped'])
        kinds = fake.kinds()
        self.assertLess(kinds.index(('host.py', 'backend', 'prepare')), kinds.index(('psql',)))
        self.assertLess(kinds.index(('psql',)), kinds.index(('wallet-control.py', 'restore', 'acknowledge', 'reboot-ack-'+generation+'.json')))
        self.assertEqual(kinds[-1], ('start', STACK))
        self.assertNotIn(('stop', STACK), kinds)  # a failed unit has nothing to stop

    def test_replay_window_refuses_before_any_mutation(self):
        fake = self.backend(now=BTIME+20+300)
        with self.assertRaises(host_program.Refused) as caught: self.reopen(fake)
        self.assertEqual(caught.exception.code, 'REPLAY_WINDOW_ACTIVE')
        self.assertEqual(caught.exception.detail['replayRemainingSeconds'], 330)
        self.assertEqual(fake.calls, []); self.assertEqual(fake.gate()['state'], 'blocked')

    def test_missing_fence_or_inactive_fence_unit_refuses(self):
        fake = self.backend(boot_fenced=False, now=BTIME+5000)
        with self.assertRaises(host_program.Refused) as caught: host_program.reopen(fake.host, BOOT, str(uuid.uuid4()), 'ref')
        self.assertEqual(caught.exception.code, 'BOOT_FENCE_MISSING')
        fake = FakeHost(self.root/'second', now=BTIME+5000); fake.units[FENCE] = 'inactive'
        with self.assertRaises(host_program.Refused) as caught: self.reopen(fake)
        # Otherwise `systemctl start kamui@backend` would rerun the fence and reblock the gate.
        self.assertEqual(caught.exception.code, 'BOOT_FENCE_UNIT_NOT_ACTIVE'); self.assertEqual(fake.calls, [])

    def test_unfinished_or_uncertain_recovery_jobs_keep_the_gate_blocked(self):
        fake = self.backend(now=BTIME+5000); fake.boot_failed_stack(); fake.jobs = (2, 1, 1)
        with self.assertRaises(host_program.Refused) as caught: self.reopen(fake)
        self.assertEqual(caught.exception.code, 'RECOVERY_JOBS_UNFINISHED')
        self.assertEqual(caught.exception.detail['recoveryJobs'], {'unfinished': 2, 'withIntent': 1, 'reconciling': 1})
        self.assertEqual(fake.gate()['state'], 'blocked'); self.assertNotEqual(fake.units[STACK], 'active')
        self.assertFalse(any(k[0] == 'wallet-control.py' for k in fake.kinds()))

    def test_identity_and_gate_mismatches_refuse(self):
        fake = self.backend(now=BTIME+5000)
        cases = [(lambda: host_program.reopen(fake.host, BOOT.replace('0f', '1f'), fake.gate()['generation'], 'r'), 'HOST_REBOOTED_SINCE_INSPECTION'),
                 (lambda: host_program.reopen(fake.host, BOOT, str(uuid.uuid4()), 'r'), 'RESTORE_GATE_GENERATION_CHANGED'),
                 (lambda: host_program.reopen(fake.host, BOOT, fake.gate()['generation'], 'bad ref;'), 'REOPEN_INPUT_INVALID')]
        for call, code in cases:
            with self.assertRaises(host_program.Refused) as caught: call()
            self.assertEqual(caught.exception.code, code)
        gate = fake.gate(); gate['changedAt'] = (BTIME-10)*1000; fake.write_gate(gate)
        with self.assertRaises(host_program.Refused) as caught: self.reopen(fake)
        self.assertEqual(caught.exception.code, 'RESTORE_GATE_NOT_FROM_THIS_BOOT')
        gate['changedAt'] = (BTIME+20)*1000; gate['reason'] = 'fresh'; fake.write_gate(gate)
        with self.assertRaises(host_program.Refused) as caught: self.reopen(fake)
        self.assertEqual(caught.exception.code, 'RESTORE_GATE_REASON_NOT_RESTORE'); self.assertEqual(fake.calls, [])

    def test_active_stack_is_stopped_first_and_stray_writers_refuse(self):
        fake = self.backend(now=BTIME+5000); fake.units[STACK] = 'active'
        fake.services = {'postgres': ('running', 'healthy'), 'api': ('running', 'unhealthy')}
        self.assertEqual(self.reopen(fake)['status'], 'reopened')
        self.assertEqual(fake.kinds()[0], ('stop', STACK))
        fake = FakeHost(self.root/'stray', now=BTIME+5000); fake.services = {'api': ('running', '')}
        with self.assertRaises(host_program.Refused) as caught: self.reopen(fake)
        self.assertEqual(caught.exception.code, 'WRITERS_RUNNING_OUTSIDE_STACK_UNIT')
        self.assertEqual(fake.gate()['state'], 'blocked')

    def test_rerun_after_failed_start_skips_acknowledgement_and_open_stack_is_left_alone(self):
        fake = self.backend(now=BTIME+5000); fake.boot_failed_stack(); fake.start_fails = True
        with self.assertRaises(host_program.Refused) as caught: self.reopen(fake)
        self.assertEqual(caught.exception.code, 'STACK_START_FAILED')
        self.assertEqual(fake.gate()['state'], 'ready')
        fake.start_fails = False; fake.calls.clear()
        self.assertEqual(host_program.inspect_backend(fake.host)['replayRemainingSeconds'], 0)
        result = self.reopen(fake)
        self.assertEqual((result['status'], result['acknowledgedNow']), ('reopened', False))
        self.assertFalse(any(k[0] == 'wallet-control.py' for k in fake.kinds()))
        fake.calls.clear()
        self.assertEqual(self.reopen(fake)['status'], 'already_open'); self.assertEqual(fake.calls, [])
        with self.assertRaises(host_program.Refused) as caught: self.reopen(fake, 'another-review')
        self.assertEqual(caught.exception.code, 'RESTORE_GATE_READY_FOR_ANOTHER_REVIEW')

    def test_wallet_control_refusal_is_reported_with_its_code_and_stack_not_started(self):
        fake = self.backend(now=BTIME+5000); fake.wallet_refusal = 'RESTORE_GATE_BUSY'
        with self.assertRaises(host_program.Refused) as caught: self.reopen(fake)
        self.assertEqual((caught.exception.code, caught.exception.detail), ('ACKNOWLEDGEMENT_REFUSED', {'walletControl': 'RESTORE_GATE_BUSY'}))
        self.assertNotIn(('start', STACK), fake.kinds())

    def test_inspect_is_read_only_and_reports_unknown_jobs_without_postgres(self):
        fake = self.backend(now=BTIME+20+100)
        value = host_program.inspect_backend(fake.host)
        self.assertEqual((value['fence'], value['fenceUnit'], value['gate']['state'], value['gate']['thisBoot']), ('current', 'active', 'blocked', True))
        self.assertEqual(value['replayRemainingSeconds'], 530); self.assertIsNone(value['recoveryJobs'])
        fake.boot_failed_stack(); fake.jobs = (1, 0, 0)
        self.assertEqual(host_program.inspect_backend(fake.host)['recoveryJobs']['unfinished'], 1)
        self.assertEqual([k for k in fake.kinds() if k != ('psql',)], [])

    def test_fence_runs_once_per_boot(self):
        fake = self.backend(boot_fenced=False, now=BTIME+50)
        self.assertEqual(host_program.fence(fake.host, BOOT), {'status': 'fenced'})
        self.assertEqual((fake.gate()['state'], fake.units[FENCE]), ('blocked', 'active'))
        self.assertEqual(host_program.fence(fake.host, BOOT), {'status': 'already_fenced'})
        self.assertEqual(fake.kinds(), [('start', FENCE)])
        with self.assertRaises(host_program.Refused): host_program.fence(fake.host, BOOT.replace('0f', '1f'))

    def test_enable_boot_enables_pepper_stack_but_only_the_backend_fence(self):
        backend = self.backend()
        result = host_program.enable_boot(backend.host, 'backend')
        self.assertEqual((result['unit'], result['stackEnabled']), (FENCE, 'disabled'))
        self.assertTrue((backend.root/'etc/systemd/system/multi-user.target.wants'/FENCE).is_symlink())
        self.assertEqual(backend.kinds(), [('add-wants', 'multi-user.target')])
        pepper = FakeHost(self.root/'pepper', role='pepper')
        self.assertEqual(host_program.enable_boot(pepper.host, 'pepper')['unit'], 'kamui@pepper.service')
        self.assertEqual(pepper.enabled['kamui@pepper.service'], 'enabled')

    def test_main_prints_one_result_line_and_hides_unexpected_errors(self):
        fake = self.backend()
        output = io.StringIO()
        with contextlib.redirect_stdout(output): host_program.main(['inspect', 'backend'], fake.host)
        self.assertEqual(len(reopen.parse(output.getvalue())), len(json.loads(output.getvalue()[len(host_program.RESULT):])))
        (fake.root/'proc/stat').write_text('garbage')
        result = quiet(host_program.main, ['inspect', 'backend'], fake.host)
        self.assertEqual(result['code'], 'HOST_BOOT_IDENTITY_UNREADABLE')
        fake.host.run = lambda args: (_ for _ in ()).throw(RuntimeError('private detail'))
        (fake.root/'proc/stat').write_text('btime %d\n' % BTIME)
        result = quiet(host_program.main, ['inspect', 'backend'], fake.host)
        self.assertEqual(result, {'status': 'refused', 'code': 'HOST_PROGRAM_FAILED'})
        self.assertEqual(quiet(host_program.main, ['reopen', 'x'], fake.host)['code'], 'HOST_ACTION_INVALID')

    def test_host_program_runs_on_al2023_python(self):
        ast.parse((Path(__file__).parent/'reopen_host.py').read_text(), feature_version=(3, 9))


class FakeDriver:
    def __init__(self, hosts): self.hosts, self.sent = hosts, []
    def target(self, role): return {'InstanceId': 'i-0123456789abcdef'+('0' if role == 'backend' else '1')}

    def command(self, role, label, instance, command):
        line = [x for x in command.splitlines() if x.startswith('python3 -I - ')][0]
        argv = shlex.split(line.split('<<')[0])[3:]
        self.sent.append((role, label, argv[0]))
        output = io.StringIO()
        with contextlib.redirect_stdout(output): host_program.main(argv, self.hosts[role].host)
        return {'status': 'success', 'output': output.getvalue()}


class WorkstationTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        base = Path(self.directory.name).resolve()
        self.root = base/'private'; self.root.mkdir(mode=0o700)
        self.backend = FakeHost(base/'backend', now=BTIME+20+90); self.backend.boot_failed_stack()
        self.pepper = FakeHost(base/'pepper', role='pepper', now=BTIME+60)
        self.driver = FakeDriver({'backend': self.backend, 'pepper': self.pepper})
        self.lines, self.sleeps, self.prompts = [], [], []

    def tool(self, answer='REOPEN'):
        def sleep(seconds): self.sleeps.append(seconds); self.backend.clock += seconds
        def confirm(prompt): self.prompts.append(prompt); return answer
        return reopen.Reopen(self.root, self.driver, sleep=sleep, confirm=confirm, out=self.lines.append)

    def evidence(self): return sorted(p.name for p in (self.root/'installation/reboot').iterdir())

    def test_reopen_confirms_then_waits_out_the_replay_window_then_reopens(self):
        generation = self.backend.gate()['generation']
        result = self.tool().reopen('review/reboot-1')
        self.assertEqual(result['status'], 'BACKEND_REOPENED'); self.assertTrue(result['pepperHealthy'])
        self.assertEqual(len(self.prompts), 1); self.assertEqual(self.sleeps, [540])
        self.assertEqual(self.backend.gate()['state'], 'ready')
        self.assertEqual([s for s in self.driver.sent if s[1] == 'reopen'], [('backend', 'reopen', 'reopen')])
        printed = '\n'.join(self.lines)+json.dumps(result)
        self.assertNotIn(generation, printed); self.assertNotIn(BOOT, printed)
        files = self.evidence()
        self.assertTrue(any('-reopen-attestation-' in f for f in files) and any('-reopen-result-' in f for f in files))
        attestation = [f for f in files if '-reopen-attestation-' in f][0]
        record = json.loads(common.read_private(self.root/'installation/reboot'/attestation))
        self.assertEqual((record['generation'], record['reviewRef']), (generation, 'review/reboot-1'))
        self.assertIn('signerHistoryReconciled', record['attestations'])

    def test_no_confirmation_sends_nothing_mutating(self):
        with self.assertRaises(ValueError) as caught: self.tool('yes').reopen('review-1')
        self.assertEqual(str(caught.exception), 'REOPEN_NOT_CONFIRMED')
        self.assertEqual({s[1] for s in self.driver.sent}, {'inspect'}); self.assertEqual(self.backend.gate()['state'], 'blocked')

    def test_missing_fence_is_reported_then_fence_starts_the_window(self):
        base = Path(self.directory.name).resolve()
        self.backend = FakeHost(base/'unfenced', boot_fenced=False, now=BTIME+400); self.driver.hosts['backend'] = self.backend
        with self.assertRaises(ValueError) as caught: self.tool().reopen('review-1')
        self.assertEqual(str(caught.exception), 'REOPEN_BOOT_FENCE_MISSING_RUN_FENCE_FIRST'); self.assertEqual(self.prompts, [])
        self.assertEqual(self.tool().fence()['status'], 'BOOT_FENCE_APPLIED_REPLAY_WINDOW_STARTED')
        self.assertEqual(self.tool().fence()['status'], 'BOOT_FENCE_ALREADY_CURRENT')
        self.assertEqual(self.tool().reopen('review-1')['status'], 'BACKEND_REOPENED')
        self.assertEqual(self.sleeps, [630])

    def test_unfinished_recovery_jobs_refuse_before_confirmation_or_on_host(self):
        self.backend.jobs = (1, 1, 0)
        with self.assertRaises(ValueError) as caught: self.tool().reopen('review-1')
        self.assertEqual(str(caught.exception), 'REOPEN_RECOVERY_JOBS_UNFINISHED'); self.assertEqual(self.prompts, [])
        # PostgreSQL down at inspection: the host checks after starting it alone, before acknowledging.
        self.backend.services.pop('postgres')
        with self.assertRaises(ValueError) as caught: self.tool().reopen('review-1')
        self.assertEqual(str(caught.exception), 'REOPEN_RECOVERY_JOBS_UNFINISHED')
        self.assertEqual(self.backend.gate()['state'], 'blocked')

    def test_already_open_backend_is_not_touched(self):
        self.backend.clock += 1000
        self.tool().reopen('review-1'); sent = len(self.driver.sent)
        self.assertEqual(self.tool().reopen('review-1')['status'], 'BACKEND_ALREADY_OPEN')
        self.assertEqual({s[1] for s in self.driver.sent[sent:]}, {'inspect'})

    def test_invalid_review_reference_and_wait_reinspection_changes_refuse(self):
        with self.assertRaises(ValueError): self.tool().reopen('has space')
        tool = self.tool()
        def reboot_during_wait(seconds): self.backend.fence_now(self.backend.clock + seconds); self.backend.clock += seconds
        tool.sleep = reboot_during_wait
        with self.assertRaises(ValueError) as caught: tool.reopen('review-1')
        self.assertEqual(str(caught.exception), 'REOPEN_HOST_STATE_CHANGED_DURING_WAIT')

    def test_status_and_enable_boot(self):
        status = self.tool().status()
        self.assertEqual(status['backend']['gate']['state'], 'blocked'); self.assertNotIn('generation', status['backend']['gate'])
        result = self.tool().enable_boot()
        self.assertEqual((result['pepper']['unit'], result['backend']['unit']), ('kamui@pepper.service', FENCE))
        self.assertEqual(self.pepper.enabled['kamui@pepper.service'], 'enabled')
        self.assertEqual(self.backend.enabled[STACK], 'disabled')


class CommandTest(unittest.TestCase):
    def test_command_embeds_reviewed_program_and_quoted_arguments(self):
        command = reopen.host_command('reopen', BOOT, str(uuid.uuid4()), 'review/one')
        self.assertIn((Path(__file__).parent/'reopen_host.py').read_text().rstrip('\n'), command)
        self.assertTrue(command.rstrip('\n').endswith('\n'+reopen.DELIMITER))
        self.assertEqual(subprocess.run(['sh', '-n'], input=command, text=True).returncode, 0)
        for bad in ['a b', 'x;rm', "q'", '']:
            with self.assertRaises(ValueError): reopen.host_command('reopen', bad)
        with self.assertRaises(ValueError): reopen.host_command('shell', 'x')

    def test_generated_shell_passes_arguments_to_the_program_on_stdin(self):
        # Drop only the root check: the program then reports ROOT_REQUIRED (or refuses on a non-Linux root).
        command = reopen.host_command('inspect', 'backend').replace('[ "$(id -u)" = 0 ]\n', '', 1)
        done = subprocess.run(['sh', '-c', command], capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0)
        self.assertEqual(reopen.parse(done.stdout)['status'], 'refused')

    def test_parse_requires_exactly_one_known_result(self):
        line = host_program.RESULT+json.dumps({'status': 'refused', 'code': 'X_Y_Z'})
        self.assertEqual(reopen.parse('noise\n'+line+'\n')['code'], 'X_Y_Z')
        for output in ['', line+'\n'+line, host_program.RESULT+'{', host_program.RESULT+json.dumps({'status': 'other'}),
                       host_program.RESULT+json.dumps({'status': 'refused', 'code': 'lower'})]:
            with self.assertRaises(ValueError): reopen.parse(output)


class DriverLabelTest(unittest.TestCase):
    def test_reboot_labels_return_output_and_observe_again_each_run(self):
        with tempfile.TemporaryDirectory() as d:
            _, aws, driver = test_install.InstallationTest().fixture(d)
            original = aws.request
            def request(profile, service, operation, inputs):
                reply = original(profile, service, operation, inputs)
                if operation == 'get-command-invocation': reply['StandardOutputContent'] = 'RESULT'
                return reply
            aws.request = request
            first = driver.command('backend', 'inspect', 'i-0123456789abcdef0', 'true\n')
            second = driver.command('backend', 'inspect', 'i-0123456789abcdef0', 'true\n')
            self.assertEqual((first['output'], second['output']), ('RESULT', 'RESULT'))
            self.assertEqual(sum(c[2] == 'send-command' for c in aws.calls), 2)
            self.assertNotIn('output', driver.command('backend', 'install', 'i-0123456789abcdef0', 'true\n'))
            with self.assertRaises(ValueError): driver.command('backend', 'shell', 'i-0123456789abcdef0', 'true\n')


if __name__ == '__main__':
    unittest.main()
