"""Approving an app for sponsorship, and reloading an open backend's runtime. No AWS or real host."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
import uuid

import test_reopen
import test_runtime
from test_reopen import BOOT, BTIME, STACK, FakeDriver, FakeHost, host_program

spec = importlib.util.spec_from_file_location('sponsor_app_test', Path(__file__).parent/'sponsor_app.py')
sponsor_app = importlib.util.module_from_spec(spec); spec.loader.exec_module(sponsor_app)
runtime = sponsor_app.runtime
KEY = 'ping-demo-sepolia'


class RegisterTest(unittest.TestCase):
    def root(self, policy=True):
        d = tempfile.TemporaryDirectory(); self.addCleanup(d.cleanup)
        root = Path(d.name).resolve(); root.chmod(0o700); (root/'installation').mkdir(mode=0o700)
        decisions = {'version': 1, 'funding': {'deploysPerHour': 10, **({'policy': test_runtime.open_policy()} if policy else {})}}
        path = root/'installation'/runtime.DECISIONS; path.write_text(json.dumps(decisions)); path.chmod(0o600)
        return root

    def decisions(self, root): return json.loads((root/'installation'/runtime.DECISIONS).read_text())

    def test_register_keeps_the_credential_private_and_only_its_hash_in_the_policy(self):
        root = self.root()
        result = sponsor_app.register(root, KEY)
        token_file = Path(result['credentialFile'])
        token = token_file.read_text().strip()
        self.assertEqual(len(token), 64)
        self.assertEqual(stat.S_IMODE(token_file.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(token_file.parent.stat().st_mode), 0o700)
        self.assertNotIn(token, json.dumps(result))
        app = self.decisions(root)['funding']['policy']['apps'][KEY]
        self.assertEqual(app['credentialHash'], hashlib.sha256(token.encode()).hexdigest())
        self.assertNotIn(token, (root/'installation'/runtime.DECISIONS).read_text())
        self.assertEqual(result['status'], 'SPONSOR_APP_REGISTERED_RUN_08_13_14_RELOAD')
        # Old decisions are kept as evidence; the new ones are still a valid, private decision.
        self.assertEqual(len(list((root/'installation/runtime-history').iterdir())), 1)
        runtime.load_decisions(root)
        self.assertEqual(sponsor_app.register(root, KEY)['status'], 'SPONSOR_APP_ALREADY_REGISTERED')
        self.assertEqual(token_file.read_text().strip(), token)
        self.assertEqual(sponsor_app.status(root)['apps'], {KEY: str(token_file)})

    def test_refusals(self):
        with self.assertRaisesRegex(ValueError, 'SPONSOR_APP_KEY_INVALID'): sponsor_app.register(self.root(), 'short')
        with self.assertRaisesRegex(ValueError, 'SPONSOR_FUNDING_POLICY_NOT_DECIDED'): sponsor_app.register(self.root(policy=False), KEY)
        root = self.root(); token_file = Path(sponsor_app.register(root, KEY)['credentialFile'])
        token_file.unlink()
        with self.assertRaisesRegex(ValueError, 'SPONSOR_APP_REGISTERED_WITH_ANOTHER_CREDENTIAL'): sponsor_app.register(root, KEY)


def open_backend(base):
    fake = FakeHost(base, now=BTIME+20+700)
    gate = fake.gate(); fake.write_gate({**gate, 'state': 'ready', 'mode': 'restored', 'reviewRef': 'opened'})
    fake.units[STACK] = 'active'
    fake.services = {'postgres': ('running', 'healthy'), 'api': ('running', 'healthy'), 'keychain': ('running', 'healthy'),
                     'caddy': ('running', ''), 'watcher': ('running', '')}
    return fake


class ReloadTest(unittest.TestCase):
    def setUp(self):
        d = tempfile.TemporaryDirectory(); self.addCleanup(d.cleanup); self.base = Path(d.name).resolve()

    def test_an_open_backend_restarts_with_the_same_open_gate(self):
        fake = open_backend(self.base/'b'); generation = fake.gate()['generation']
        result = host_program.reload_runtime(fake.host)
        self.assertEqual(result['status'], 'runtime_reloaded')
        self.assertEqual([c for c in fake.calls if c[0] in {'stop', 'start', 'host.py'}], [('stop', STACK), ('host.py', 'backend', 'prepare'), ('start', STACK)])
        self.assertEqual((fake.gate()['state'], fake.gate()['generation']), ('ready', generation))

    def test_a_closed_gate_or_unfinished_recovery_changes_nothing(self):
        fake = FakeHost(self.base/'blocked', now=BTIME+60)
        with self.assertRaises(host_program.Refused) as caught: host_program.reload_runtime(fake.host)
        self.assertEqual(caught.exception.code, 'RESTORE_GATE_NOT_READY_RUN_14_REOPEN')
        fake = open_backend(self.base/'jobs'); fake.jobs = (1, 0, 0)
        with self.assertRaises(host_program.Refused) as caught: host_program.reload_runtime(fake.host)
        self.assertEqual(caught.exception.code, 'RECOVERY_JOBS_UNFINISHED')
        self.assertFalse(any(c[0] in {'stop', 'start'} for c in fake.calls))

    def test_a_job_admitted_after_the_count_blocks_writes_instead_of_restarting(self):
        fake = open_backend(self.base/'late')
        original = fake.run
        def run(args):
            if args[:2] == ['systemctl', 'stop']: fake.jobs = (1, 1, 0)   # committed just before the stop
            if args[:2] == ['python3', '-B'] and args[2].endswith('/wallet-control.py') and args[3:] == ['restore', 'block']:
                fake.calls.append(('wallet-control.py', 'restore', 'block'))
                fake.write_gate({**fake.gate(), 'state': 'blocked', 'generation': str(uuid.uuid4()), 'changedAt': int(fake.clock*1000)})
                return 0, '', ''
            return original(args)
        fake.host.run = run
        with self.assertRaises(host_program.Refused) as caught: host_program.reload_runtime(fake.host)
        self.assertEqual(caught.exception.code, 'GATE_BLOCKED_RECOVERY_INTERRUPTED')
        self.assertEqual(caught.exception.detail['recoveryJobs']['unfinished'], 1)
        self.assertEqual(fake.gate()['state'], 'blocked')
        self.assertNotIn(('start', STACK), fake.calls)

    def test_an_unreadable_recount_also_blocks_writes(self):
        for failure in ['psql', 'prepare']:
            with self.subTest(failure=failure):
                fake = open_backend(self.base/('fail-'+failure))
                original, stopped = fake.run, []
                def run(args, original=original, fake=fake, stopped=stopped):
                    if args[:2] == ['systemctl', 'stop']: stopped.append(True)
                    if stopped and failure == 'psql' and 'psql' in args: return 1, '', ''
                    if stopped and failure == 'prepare' and args[-2:] == ['backend', 'prepare']: return 1, '', ''
                    if args[:2] == ['python3', '-B'] and args[2].endswith('/wallet-control.py') and args[3:] == ['restore', 'block']:
                        fake.write_gate({**fake.gate(), 'state': 'blocked', 'generation': str(uuid.uuid4()), 'changedAt': int(fake.clock*1000)})
                        return 0, '', ''
                    return original(args)
                fake.host.run = run
                with self.assertRaises(host_program.Refused) as caught: host_program.reload_runtime(fake.host)
                expected = {'psql': 'GATE_BLOCKED_RECOVERY_JOBS_UNREADABLE', 'prepare': 'GATE_BLOCKED_POSTGRES_PREPARE_FAILED'}[failure]
                self.assertEqual(caught.exception.code, expected)
                self.assertEqual(fake.gate()['state'], 'blocked')
                self.assertNotIn(('start', STACK), fake.calls)

    def test_workstation_reload_reports_the_digit_bearing_refusal(self):
        reopen = test_reopen.reopen
        root = self.base/'private'; root.mkdir(mode=0o700)
        backend, pepper = open_backend(self.base/'b2'), FakeHost(self.base/'p', role='pepper')
        driver = FakeDriver({'backend': backend, 'pepper': pepper})
        tool = reopen.Reopen(root, driver, confirm=lambda _: '', out=lambda *_: None)
        self.assertEqual(tool.reload_runtime()['status'], 'BACKEND_RUNTIME_RELOADED')
        self.assertEqual([s[1] for s in driver.sent], ['inspect', 'reload-runtime'])
        line = host_program.RESULT+json.dumps({'status': 'refused', 'code': 'RESTORE_GATE_NOT_READY_RUN_14_REOPEN'})
        self.assertEqual(reopen.parse(line)['code'], 'RESTORE_GATE_NOT_READY_RUN_14_REOPEN')


if __name__ == '__main__':
    unittest.main()
