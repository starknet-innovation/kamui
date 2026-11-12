#!/usr/bin/env python3
"""Local host-lock/state regressions; no Docker, AWS or database operations."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('kamui_restore', HERE/'restore.py')
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)

spec = importlib.util.spec_from_file_location('kamui_promote', HERE/'promote.py')
promote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(promote)


class RestoreControlTests(unittest.TestCase):
    def test_restore_uses_same_host_lock_before_any_gate_or_docker_action(self):
        with tempfile.TemporaryDirectory(prefix='kamui-restore-lock-') as temporary:
            state = Path(temporary)
            compose = state/'compose.yml'; compose.write_text('')
            manifest = state/'release.env'; manifest.write_text('')
            env = {'PATH': os.environ['PATH'], 'STATE_DIRECTORY': str(state), 'KAMUI_BACKUP_REVIEWED': 'yes', 'KAMUI_COMPOSE_FILE': str(compose), 'KAMUI_ENV_FILE': str(manifest)}
            with restore.host.control_lock(state):
                result = subprocess.run([sys.executable, str(HERE/'restore.py'), '--writers-stopped'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stderr), {'status': 'refused', 'error': 'HOST_CONTROL_BUSY'})
            self.assertFalse((state/'restore-gate').exists())

    def test_all_nonstopped_states_and_unknown_status_fail_closed(self):
        for state in ['running', 'restarting', 'paused', 'removing', 'unknown', None]:
            with self.subTest(state=state), self.assertRaisesRegex(ValueError, 'RESTORE_SERVICES_STILL_RUNNING'):
                restore.require_stopped([{'Service': 'postgres', 'State': state}])
        restore.require_stopped([])
        restore.require_stopped([{'State': 'exited'}, {'State': 'dead'}, {'State': 'created'}])
        with self.assertRaisesRegex(ValueError, 'RESTORE_SERVICES_STILL_RUNNING'):
            restore.require_stopped({})


    def test_promotion_preserves_old_data_at_fixed_canonical_path(self):
        with tempfile.TemporaryDirectory(prefix='kamui-promote-') as temporary:
            state = Path(temporary).resolve()
            old = state/'postgres'; old.mkdir(); (old/'old-data').write_text('old')
            target = state/'postgres-restore-test'; target.mkdir(); (target/'PG_VERSION').write_text('16')
            (target/'restored-data').write_text('new')
            previous = promote.promote_directories(state, target)
            self.assertEqual((old/'restored-data').read_text(), 'new')
            self.assertEqual((previous/'old-data').read_text(), 'old')
            self.assertFalse(target.exists())

    def test_promotion_refuses_wrong_targets_and_rolls_back_second_rename_failure(self):
        with tempfile.TemporaryDirectory(prefix='kamui-promote-') as temporary:
            state = Path(temporary).resolve()
            old = state/'postgres'; old.mkdir(); (old/'old-data').write_text('old')
            target = state/'postgres-restore-test'; target.mkdir(); (target/'PG_VERSION').write_text('16')
            wrong = state/'unrelated'; wrong.mkdir(); (wrong/'PG_VERSION').write_text('16')
            with self.assertRaisesRegex(ValueError, 'PROMOTE_RESTORE_TARGET_INVALID'):
                promote.promote_directories(state, wrong)
            def fail_second(source, destination):
                if source == target:
                    raise OSError('synthetic rename failure')
                os.rename(source, destination)
            with self.assertRaises(OSError):
                promote.promote_directories(state, target, fail_second)
            self.assertEqual((old/'old-data').read_text(), 'old')
            self.assertTrue((target/'PG_VERSION').exists())
            (target/'postmaster.pid').write_text('fixture')
            with self.assertRaisesRegex(ValueError, 'PROMOTE_STOPPED_RESTORED_DATABASE_REQUIRED'):
                promote.promote_directories(state, target)
            self.assertEqual((old/'old-data').read_text(), 'old')


if __name__ == '__main__':
    unittest.main()
