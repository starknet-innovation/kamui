#!/usr/bin/env python3
"""Each backend OS boot blocks paid writers before the stack can start. No DB required."""
import os
from pathlib import Path
import subprocess
import sys


def fence_gate(gate, marker, boot_id, run_control):
    marker.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if marker.parent.is_symlink() or marker.is_symlink():
        raise ValueError()
    marker.unlink(missing_ok=True)
    # A restored ready gate is never trusted across boot. Only a genuinely missing
    # gate can take the fresh path; fresh acknowledgement still requires an empty DB.
    action = 'block' if gate.exists() else 'initialize'
    if not run_control(action):
        raise ValueError()
    fd = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(boot_id + '\n')
        output.flush()
        os.fsync(output.fileno())


def main():
    if os.geteuid() != 0:
        raise ValueError()
    def run_control(action):
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('wallet-control.py')), 'restore', action], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return result.returncode == 0
    state = Path(os.environ.get('STATE_DIRECTORY', '/var/lib/kamui'))
    fence_gate(state/'restore-gate/state.json', Path('/run/kamui/boot-fenced'), Path('/proc/sys/kernel/random/boot_id').read_text().strip(), run_control)
    print('{"status":"blocked","boot_fence":true}')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('{"status":"refused","error":"BOOT_FENCE_FAILED"}', file=sys.stderr)
        sys.exit(1)
