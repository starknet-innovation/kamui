#!/usr/bin/env python3
"""Operator-run after a Sepolia host reboot (setup/14-reopen-after-reboot.sh).

Every backend OS boot blocks the restore gate. This command checks everything a machine can check,
then acknowledges the gate in "restored" mode **on the operator's attestation** and starts the
stack. Running `reopen` is that attestation: the command cannot know that signer history is
reconciled, so it never runs unattended and asks the operator to confirm interactively.

The host side is install/reopen_host.py, sent inline through SSM AWS-RunShellScript. Nothing in
the installed host package changes. Output is fixed status labels and counts; the gate generation,
boot id and raw command output stay in private evidence under the private directory.
"""
import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import sys
import time
import uuid

from common import Aws, AwsError, Driver, HERE, private_dir, write_private

HOST_PROGRAM = HERE/'reopen_host.py'
DELIMITER = 'KAMUI_REOPEN_HOST_PROGRAM_END'
RESULT = 'KAMUI_REOPEN_RESULT '
REF = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$')
ARGUMENT = re.compile(r'^[A-Za-z0-9._/-]{1,120}$')
CODE = re.compile(r'^[A-Z_]{3,60}$')
STATUSES = {'inspected', 'refused', 'fenced', 'already_fenced', 'reopened', 'already_open', 'enabled'}
CONFIRMATION = 'REOPEN'
MAX_WAITS = 6
# Shown before confirmation. These are what the acknowledgement records on the operator's behalf.
ATTESTATIONS = [
    ('apiAndRotatorStopped', 'Checked and enforced: the host refuses to acknowledge while api/rotator run, and the acknowledgement holds the PostgreSQL writer lease.'),
    ('originalWriterCannotRestart', 'YOU attest: no other host, clone, supervisor or old deployment can start a signer for this wallet.'),
    ('signerHistoryReconciled', 'YOU attest: the relayer/signer transaction history and nonces match trusted chain evidence up to now.'),
    ('uncertainIntentsRetained', 'YOU attest: no uncertain transaction intent was dropped (this command also refuses unfinished recovery jobs).'),
    ('replayAndBudgetsConservative', 'YOU attest: replay records and funding budgets are at least as strict as before the reboot.'),
]


def host_command(action, *args):
    """A fixed shell body: the reviewed host program on stdin, validated arguments on argv."""
    program = HOST_PROGRAM.read_text()
    if DELIMITER in program: raise ValueError('REOPEN_HOST_PROGRAM_INVALID')
    if action not in {'inspect', 'fence', 'reopen', 'enable-boot'} or not all(isinstance(a, str) and ARGUMENT.fullmatch(a) for a in args):
        raise ValueError('REOPEN_HOST_ARGUMENT_INVALID')
    q = shlex.quote
    lines = ['set -eu', 'umask 077', '[ "$(id -u)" = 0 ]', 'cd /',
             'python3 -I - '+' '.join(q(x) for x in (action,)+args)+" <<'"+DELIMITER+"'",
             program.rstrip('\n'), DELIMITER]
    return '\n'.join(lines)+'\n'


def parse(output):
    lines = [line[len(RESULT):] for line in (output or '').splitlines() if line.startswith(RESULT)]
    if len(lines) != 1: raise ValueError('REOPEN_HOST_RESULT_MISSING')
    try: value = json.loads(lines[0])
    except Exception: raise ValueError('REOPEN_HOST_RESULT_INVALID') from None
    if not isinstance(value, dict) or value.get('status') not in STATUSES: raise ValueError('REOPEN_HOST_RESULT_INVALID')
    if value['status'] == 'refused' and not CODE.fullmatch(str(value.get('code'))): raise ValueError('REOPEN_HOST_RESULT_INVALID')
    return value


def ask(prompt):
    if not sys.stdin.isatty(): raise ValueError('REOPEN_INTERACTIVE_CONFIRMATION_REQUIRED')
    return input(prompt)


class Reopen:
    def __init__(self, root, driver, sleep=time.sleep, confirm=ask, out=print):
        self.driver, self.sleep, self.confirm, self.out = driver, sleep, confirm, out
        self.directory = private_dir(private_dir(Path(root)/'installation')/'reboot')

    def evidence(self, name, value):
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        write_private(self.directory/(stamp+'-'+name+'-'+uuid.uuid4().hex[:8]+'.json'), value)

    def call(self, role, label, action, *args):
        target = self.driver.target(role)
        reply = self.driver.command(role, label, target['InstanceId'], host_command(action, *args))
        return parse(reply.get('output'))

    def inspect(self, role):
        value = self.call(role, 'inspect', 'inspect', role)
        if value['status'] == 'refused': raise ValueError(role.upper()+'_'+value['code'])
        return value

    @staticmethod
    def summary(backend=None, pepper=None):
        """Public-safe view: states and counts, never the generation or boot id."""
        result = {}
        if backend:
            result['backend'] = {k: backend.get(k) for k in ['fence', 'fenceUnit', 'fenceAtBoot', 'stackUnit', 'stackEnabled',
                                                             'replayRemainingSeconds', 'services', 'writersRunning', 'recoveryJobs']}
            result['backend']['gate'] = {k: backend['gate'].get(k) for k in ['state', 'reason', 'mode', 'thisBoot', 'ageSeconds']}
        if pepper: result['pepper'] = {k: pepper.get(k) for k in ['stackUnit', 'stackEnabled', 'healthy', 'services']}
        return result

    def status(self):
        backend, pepper = self.inspect('backend'), self.inspect('pepper')
        self.evidence('status', {'backend': backend, 'pepper': pepper})
        return {'status': 'REBOOT_STATUS_OBSERVED', **self.summary(backend, pepper)}

    def fence(self):
        backend = self.inspect('backend')
        if backend['fence'] == 'current': return {'status': 'BOOT_FENCE_ALREADY_CURRENT'}
        result = self.call('backend', 'fence', 'fence', backend['bootId'])
        self.evidence('fence', {'before': backend, 'result': result})
        if result['status'] == 'refused': raise ValueError('FENCE_'+result['code'])
        return {'status': 'BOOT_FENCE_APPLIED_REPLAY_WINDOW_STARTED'}

    def enable_boot(self):
        results = {}
        for role in ['pepper', 'backend']:
            result = self.call(role, 'enable-boot', 'enable-boot', role)
            self.evidence('enable-boot-'+role, result)
            if result['status'] == 'refused': raise ValueError('ENABLE_BOOT_'+role.upper()+'_'+result['code'])
            results[role] = {k: result.get(k) for k in ['unit', 'stackEnabled'] if k in result}
        return {'status': 'BOOT_START_ENABLED_NOT_APPLIED_UNTIL_NEXT_BOOT', **results}

    def check_backend(self, backend):
        gate = backend['gate']
        if backend['fence'] == 'missing': raise ValueError('REOPEN_BOOT_FENCE_MISSING_RUN_FENCE_FIRST')
        if backend['fence'] != 'current': raise ValueError('REOPEN_BOOT_FENCE_MARKER_INVALID')
        if backend['fenceUnit'] != 'active': raise ValueError('REOPEN_BOOT_FENCE_UNIT_NOT_ACTIVE')
        if not gate['thisBoot']: raise ValueError('REOPEN_GATE_NOT_FROM_THIS_BOOT')
        if gate['reason'] != 'restore': raise ValueError('REOPEN_GATE_REASON_NOT_RESTORE')
        if gate['state'] == 'ready' and gate.get('mode') != 'restored': raise ValueError('REOPEN_GATE_READY_UNEXPECTED_MODE')
        jobs = backend.get('recoveryJobs')
        if jobs and jobs['unfinished']: raise ValueError('REOPEN_RECOVERY_JOBS_UNFINISHED')

    def reopen(self, review_ref):
        if not isinstance(review_ref, str) or not REF.fullmatch(review_ref): raise ValueError('REOPEN_REVIEW_REF_INVALID')
        backend, pepper = self.inspect('backend'), self.inspect('pepper')
        self.evidence('reopen-inspect', {'backend': backend, 'pepper': pepper})
        self.out(json.dumps(self.summary(backend, pepper)))
        self.check_backend(backend)
        if backend['gate']['state'] == 'ready' and backend['stackUnit'] == 'active' and backend['services'].get('api') == 'running':
            return {'status': 'BACKEND_ALREADY_OPEN', 'pepperHealthy': pepper['healthy']}
        if not pepper['healthy']: self.out('WARNING_PEPPER_STACK_NOT_HEALTHY_BACKEND_REOPEN_CONTINUES')
        self.out('The restore gate will be acknowledged in "restored" mode with review reference '+review_ref+'.')
        for name, text in ATTESTATIONS: self.out('  '+name+': '+text)
        if backend['replayRemainingSeconds']:
            self.out('The replay window still has '+str(backend['replayRemainingSeconds'])+' seconds; the command waits after confirmation.')
        if self.confirm('Type '+CONFIRMATION+' to attest and reopen backend writes: ').strip() != CONFIRMATION:
            raise ValueError('REOPEN_NOT_CONFIRMED')
        generation, boot_id = backend['gate']['generation'], backend['bootId']
        self.evidence('reopen-attestation', {'reviewRef': review_ref, 'generation': generation, 'bootId': boot_id,
                                             'confirmedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                             'attestations': [name for name, _ in ATTESTATIONS]})
        for attempt in range(MAX_WAITS + 1):
            remaining = backend['replayRemainingSeconds']
            if remaining:
                if attempt == MAX_WAITS: raise ValueError('REOPEN_REPLAY_WINDOW_DID_NOT_ELAPSE')
                self.out('WAITING_REPLAY_WINDOW_SECONDS='+str(remaining))
                self.sleep(remaining)
                backend = self.inspect('backend')
                if backend['bootId'] != boot_id or backend['gate']['generation'] != generation: raise ValueError('REOPEN_HOST_STATE_CHANGED_DURING_WAIT')
                self.check_backend(backend)
                continue
            result = self.call('backend', 'reopen', 'reopen', boot_id, generation, review_ref)
            self.evidence('reopen-result', result)
            if result['status'] == 'refused' and result['code'] == 'REPLAY_WINDOW_ACTIVE' and isinstance(result.get('replayRemainingSeconds'), int):
                backend = {**backend, 'replayRemainingSeconds': max(1, result['replayRemainingSeconds'])}
                continue
            if result['status'] == 'refused':
                code = 'REOPEN_'+result['code']
                if result.get('walletControl'): code += '_'+result['walletControl']
                if result.get('recoveryJobs'): self.out(json.dumps({'recoveryJobs': result['recoveryJobs']}))
                raise ValueError(code[:100])
            return {'status': 'BACKEND_REOPENED' if result['status'] == 'reopened' else 'BACKEND_ALREADY_OPEN',
                    'acknowledgedNow': result.get('acknowledgedNow', False), 'recoveryJobs': result.get('recoveryJobs'),
                    'services': result.get('services'), 'pepperHealthy': pepper['healthy']}
        raise ValueError('REOPEN_REPLAY_WINDOW_DID_NOT_ELAPSE')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', choices=['status', 'fence', 'reopen', 'enable-boot'])
    parser.add_argument('--private-directory', default=str(Path.home()/'.kamui-hosting-sepolia'))
    parser.add_argument('--review-ref', help='reopen: your private reconciliation reference, recorded in the gate')
    options = parser.parse_args()
    if (options.action == 'reopen') != (options.review_ref is not None): raise ValueError('REOPEN_REVIEW_REF_REQUIRED_FOR_REOPEN_ONLY')
    root = private_dir(options.private_directory)
    directory = private_dir(root/'installation')
    # Same lock as 07-13: never two SSM senders against one private evidence directory.
    descriptor = os.open(directory/'.installation.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try: fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise ValueError('INSTALLATION_LOCK_BUSY') from None
        print('STEP_'+options.action.upper().replace('-', '_'), flush=True)
        tool = Reopen(root, Driver(root, Aws(root)))
        if options.action == 'reopen': result = tool.reopen(options.review_ref)
        elif options.action == 'enable-boot': result = tool.enable_boot()
        else: result = getattr(tool, options.action)()
        print(json.dumps(result))
    finally: os.close(descriptor)


if __name__ == '__main__':
    try: main()
    except Exception as error:
        code = str(error) if isinstance(error, (ValueError, AwsError)) and re.fullmatch('[A-Z_]{3,100}', str(error)) else 'REOPEN_STOPPED_PRIVATE_EVIDENCE_RETAINED'
        print(code); raise SystemExit(1)
