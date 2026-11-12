#!/usr/bin/env python3
"""Local status/disk/gate probe. Fixed status only; no container logs/config/identifiers."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in {'backend', 'pepper'}:
        raise ValueError()
    role = sys.argv[1]
    helper = Path(__file__).with_name('host.py')
    checked = subprocess.run([sys.executable, str(helper), role, 'status'], capture_output=True, text=True)
    if checked.returncode:
        raise ValueError()
    rows = json.loads(checked.stdout)
    expected = {'caddy', 'pepper'} if role == 'pepper' else {'caddy', 'keychain', 'api', 'postgres', 'rotator', 'watcher'}
    healthy = {row['service'] for row in rows if row['state'] == 'running' and row['health'] in {'', None, 'healthy'}}
    issues = []
    if healthy != expected:
        issues.append('SERVICE_UNHEALTHY')
    state = Path(os.environ.get('STATE_DIRECTORY', '/var/lib/kamui'))
    disk = shutil.disk_usage(state)
    if disk.free < 2 * 1024**3 or disk.free / disk.total < 0.15:
        issues.append('DISK_SPACE_LOW')
    if role == 'backend':
        try:
            gate = json.loads((state/'restore-gate/state.json').read_text())
            if gate.get('version') != 1 or gate.get('state') != 'ready':
                issues.append('RESTORE_GATE_BLOCKED')
        except Exception:
            issues.append('RESTORE_GATE_BLOCKED')
    print(json.dumps({'role': role, 'ok': not issues, 'issues': issues}))
    return bool(issues)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('{"ok":false,"issues":["MONITOR_UNAVAILABLE"]}')
        sys.exit(1)
