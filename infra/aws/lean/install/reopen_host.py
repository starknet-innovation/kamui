#!/usr/bin/env python3
"""Runs ON a host, sent inline through SSM by install/reopen.py. Not part of the host package.

It only calls the installed reviewed wrappers (host.py, wallet-control.py, systemctl) and reads
the restore gate, the boot-fence marker and recovery-job counts. Output is one fixed result line
with statuses, counts and the gate generation/boot id (random identifiers, kept in private
workstation evidence); no command output, configuration or database row is ever echoed.

Python 3.9 (AL2023 system python): no newer syntax.
"""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import uuid

RESULT = 'KAMUI_REOPEN_RESULT '
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
BOOT_ID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
REF = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$')
CODE = re.compile(r'^[A-Z0-9_]{3,60}$')
HELD_LOCK = 'KAMUI_HOST_CONTROL_LOCK_FD'  # scripts/host.py inherited_lock
# services/backend/src/storage/restore-fence.ts RESTORE_REPLAY_WAIT_MS, plus clock margin.
REPLAY_WAIT_SECONDS = 600
REPLAY_MARGIN_SECONDS = 30
WRITERS = {'api', 'rotator'}
STOPPED = {'exited', 'dead', 'created'}
LEAN = '/opt/kamui/lean'
STACK = 'kamui@backend.service'
FENCE = 'kamui-backend-boot-fence.service'
BACKEND_SERVICES = {'caddy', 'keychain', 'api', 'postgres', 'watcher'}
PEPPER_SERVICES = {'caddy', 'pepper'}
JOBS_TABLE = "SELECT to_regclass('public.recovery_jobs') IS NOT NULL"
# Non-terminal = finished_at IS NULL (services/backend/src/services/recovery/postgres-store.ts).
# A retained intent means a transaction may have been sent with an unknown outcome.
JOBS_COUNTS = ("BEGIN READ ONLY; SELECT COUNT(*) FILTER (WHERE finished_at IS NULL), "
               "COUNT(*) FILTER (WHERE finished_at IS NULL AND intent IS NOT NULL), "
               "COUNT(*) FILTER (WHERE finished_at IS NULL AND state LIKE '%reconciling%') "
               "FROM public.recovery_jobs; COMMIT;")


class Refused(Exception):
    def __init__(self, code, **detail):
        super().__init__(code)
        self.code, self.detail = code, detail


def system_run(args):
    env = {k: v for k, v in os.environ.items() if k not in {'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'POSTGRES_DATA_DIRECTORY', 'KAMUI_ENABLE_AVNU'}}
    env.update(SYSTEMD_PAGER='', SYSTEMD_COLORS='0', DOCKER_HOST='unix:///var/run/docker.sock',
               CONFIG_DIRECTORY='/etc/kamui', STATE_DIRECTORY='/var/lib/kamui')
    # A full backup grows with the database; everything else is short.
    timeout = 3600 if any('backup.sh' in str(a) for a in args) else 420
    # While an upgrade preparation holds the host control lock, its own host.py and
    # wallet-control.py calls inherit it; nobody else can take it.
    held = os.environ.get(HELD_LOCK)
    try:
        done = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=env,
                              pass_fds=(int(held),) if held else ())
    except subprocess.TimeoutExpired:
        return 124, '', ''
    return done.returncode, done.stdout, done.stderr


class Host:
    """Every side effect goes through here so tests can substitute a fake host."""
    def __init__(self, root=Path('/'), run=system_run, now=time.time):
        self.root, self.run, self.now = Path(root), run, now

    def at(self, absolute): return self.root/absolute.lstrip('/')

    @contextmanager
    def control_lock(self):
        """The lifecycle lock scripts/host.py and wallet-control.py take, held across a whole step."""
        state = self.at('/var/lib/kamui')
        if state.is_symlink() or not state.is_dir(): raise Refused('STATE_DIRECTORY_REQUIRED')
        fd = os.open(state/'.operator.lock', os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077: raise Refused('HOST_CONTROL_LOCK_INVALID')
            try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: raise Refused('HOST_CONTROL_BUSY') from None
            os.set_inheritable(fd, True)
            os.environ[HELD_LOCK] = str(fd)
            self.lock_fd = fd
            try: yield
            finally:
                os.environ.pop(HELD_LOCK, None); self.lock_fd = None
        finally: os.close(fd)

    def inherits_lock(self):
        """Whether the installed wrappers accept the held lock (scripts/host.py inherited_lock)."""
        try: return HELD_LOCK in self.at(LEAN+'/scripts/host.py').read_text()
        except OSError: return False

    @contextmanager
    def lock_handoff(self):
        """Around a host.py / wallet-control.py call made while holding the control lock.

        Wrappers from this release inherit the lock. An older installed release (the first upgrade
        away from it) cannot: the lock is released for that one call and taken back immediately
        after, refusing if anybody else took it meanwhile. Callers re-check what they rely on."""
        fd = getattr(self, 'lock_fd', None)
        if fd is None or self.inherits_lock():
            yield; return
        fcntl.flock(fd, fcntl.LOCK_UN); os.environ.pop(HELD_LOCK, None)
        try: yield
        finally:
            try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: raise Refused('HOST_CONTROL_BUSY') from None
            os.environ[HELD_LOCK] = str(fd)

    def boot(self):
        boot_id = self.at('/proc/sys/kernel/random/boot_id').read_text().strip()
        btime = [int(line.split()[1]) for line in self.at('/proc/stat').read_text().splitlines() if line.startswith('btime ')]
        if not BOOT_ID.fullmatch(boot_id) or len(btime) != 1: raise Refused('HOST_BOOT_IDENTITY_UNREADABLE')
        return boot_id, btime[0]

    def unit(self, name, query='is-active'):
        code, out, _ = self.run(['systemctl', query, name])
        value = out.strip().splitlines()[0] if out.strip() else ''
        return value if re.fullmatch(r'[a-z-]{1,40}', value) else 'unknown'

    def services(self, role):
        code, out, _ = self.run(['python3', '-B', LEAN+'/scripts/host.py', role, 'status'])
        if code: raise Refused('COMPOSE_STATUS_FAILED')
        try:
            rows = json.loads(out)
            return {str(r['service']): {'state': str(r.get('state')), 'health': r.get('health') or ''} for r in rows}
        except Exception: raise Refused('COMPOSE_STATUS_FAILED') from None


def fence_state(host, boot_id):
    marker = host.at('/run/kamui/boot-fenced')
    if marker.is_symlink(): return 'invalid'
    if not marker.exists(): return 'missing'
    try: value = marker.read_text().strip()
    except OSError: return 'invalid'
    return 'current' if value == boot_id else 'stale'


def read_gate(host):
    path = host.at('/var/lib/kamui/restore-gate/state.json')
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > 4096: raise ValueError()
        gate = json.loads(path.read_text())
        if gate.get('version') != 1 or gate.get('state') not in {'blocked', 'ready'} or gate.get('reason') not in {'fresh', 'restore'}: raise ValueError()
        if not isinstance(gate.get('generation'), str) or not UUID.fullmatch(gate['generation']): raise ValueError()
        if not isinstance(gate.get('changedAt'), int) or isinstance(gate['changedAt'], bool) or gate['changedAt'] <= 0: raise ValueError()
        return gate
    except Exception: raise Refused('RESTORE_GATE_UNREADABLE') from None


def recovery_jobs(host, services):
    """Counts only. None when PostgreSQL is not running (nothing can be concluded)."""
    row = services.get('postgres', {})
    if row.get('state') != 'running' or row.get('health') not in {'', 'healthy'}: return None
    psql = ['docker', 'compose', '--env-file', '/etc/kamui/release.env', '-f', LEAN+'/backend/compose.yml', 'exec', '-T',
            'postgres', 'psql', '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'kamui', '-c']
    code, out, _ = host.run(psql+[JOBS_TABLE])
    if code or out.strip() not in {'t', 'f'}: raise Refused('RECOVERY_JOBS_UNREADABLE')
    if out.strip() == 'f': raise Refused('RECOVERY_JOBS_TABLE_MISSING')
    code, out, _ = host.run(psql+[JOBS_COUNTS])
    rows = [line for line in out.splitlines() if re.fullmatch(r'[0-9]+\|[0-9]+\|[0-9]+', line.strip())]
    if code or len(rows) != 1: raise Refused('RECOVERY_JOBS_UNREADABLE')
    unfinished, with_intent, reconciling = (int(x) for x in rows[0].strip().split('|'))
    return {'unfinished': unfinished, 'withIntent': with_intent, 'reconciling': reconciling}


def writers_running(services):
    return sorted(name for name, row in services.items() if name in WRITERS and row['state'] not in STOPPED)


def inspect_backend(host):
    boot_id, btime = host.boot()
    gate = read_gate(host)
    services = host.services('backend')
    elapsed = host.now() - gate['changedAt']/1000
    return {
        'role': 'backend', 'bootId': boot_id,
        'fence': fence_state(host, boot_id), 'fenceUnit': host.unit(FENCE),
        'fenceAtBoot': host.at('/etc/systemd/system/multi-user.target.wants/'+FENCE).is_symlink(),
        'stackUnit': host.unit(STACK), 'stackEnabled': host.unit(STACK, 'is-enabled'),
        'gate': {'state': gate['state'], 'reason': gate['reason'], 'mode': gate.get('mode'), 'generation': gate['generation'],
                 'thisBoot': gate['changedAt']/1000 >= btime, 'ageSeconds': max(0, int(elapsed))},
        # Only a blocked gate has a replay window; a ready one was already acknowledged.
        'replayRemainingSeconds': 0 if gate['state'] == 'ready' else max(0, int(REPLAY_WAIT_SECONDS + REPLAY_MARGIN_SECONDS - elapsed + 0.999)),
        'services': {name: row['state'] for name, row in sorted(services.items())},
        'writersRunning': writers_running(services),
        'recoveryJobs': recovery_jobs(host, services),
    }


def inspect_pepper(host):
    boot_id, _ = host.boot()
    services = host.services('pepper')
    healthy = {n for n, r in services.items() if r['state'] == 'running' and r['health'] in {'', 'healthy'}}
    return {'role': 'pepper', 'bootId': boot_id, 'stackUnit': host.unit('kamui@pepper.service'),
            'stackEnabled': host.unit('kamui@pepper.service', 'is-enabled'), 'healthy': healthy == PEPPER_SERVICES,
            'services': {name: row['state'] for name, row in sorted(services.items())}}


def fence(host, expected_boot):
    boot_id, _ = host.boot()
    if boot_id != expected_boot: raise Refused('HOST_REBOOTED_SINCE_INSPECTION')
    state = fence_state(host, boot_id)
    if state == 'current': return {'status': 'already_fenced'}
    if state != 'missing': raise Refused('BOOT_FENCE_MARKER_INVALID')
    if host.unit(FENCE) != 'inactive': raise Refused('BOOT_FENCE_UNIT_NOT_INACTIVE')
    if host.unit(STACK) == 'active': raise Refused('STACK_ACTIVE_WITHOUT_BOOT_FENCE')
    code, _, _ = host.run(['systemctl', 'start', FENCE])
    if code or fence_state(host, boot_id) != 'current' or read_gate(host)['state'] != 'blocked': raise Refused('BOOT_FENCE_FAILED')
    return {'status': 'fenced'}


def write_acknowledgement(host, name, value):
    directory = host.at('/etc/kamui/operator')
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077: raise Refused('OPERATOR_DIRECTORY_INVALID')
    temporary = directory/('.'+name+'.tmp')
    if temporary.is_symlink() or temporary.exists(): temporary.unlink()
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(json.dumps(value)+'\n'); output.flush(); os.fsync(output.fileno())
    os.replace(temporary, directory/name)


def start_stack(host, generation):
    code, _, _ = host.run(['systemctl', 'start', STACK])
    if code: raise Refused('STACK_START_FAILED')
    gate = read_gate(host)
    # A re-run boot fence would have replaced the generation: never report that as open.
    if gate['state'] != 'ready' or gate['generation'] != generation: raise Refused('RESTORE_GATE_REBLOCKED_DURING_START')
    services = host.services('backend')
    if host.unit(STACK) != 'active' or not healthy_backend(services): raise Refused('STACK_NOT_HEALTHY_AFTER_START')
    return {name: row['state'] for name, row in sorted(services.items())}


def reopen(host, expected_boot, generation, review_ref):
    if not BOOT_ID.fullmatch(expected_boot) or not UUID.fullmatch(generation) or not REF.fullmatch(review_ref): raise Refused('REOPEN_INPUT_INVALID')
    boot_id, btime = host.boot()
    if boot_id != expected_boot: raise Refused('HOST_REBOOTED_SINCE_INSPECTION')
    if fence_state(host, boot_id) != 'current': raise Refused('BOOT_FENCE_MISSING')
    # Starting the stack pulls the fence in. If it were not already active this boot it would run
    # again, reblock the gate and silently undo this acknowledgement.
    if host.unit(FENCE) != 'active': raise Refused('BOOT_FENCE_UNIT_NOT_ACTIVE')
    gate = read_gate(host)
    if gate['generation'] != generation: raise Refused('RESTORE_GATE_GENERATION_CHANGED')
    if gate['changedAt']/1000 < btime: raise Refused('RESTORE_GATE_NOT_FROM_THIS_BOOT')
    if gate['reason'] != 'restore': raise Refused('RESTORE_GATE_REASON_NOT_RESTORE')
    acknowledged = gate['state'] == 'ready'
    if acknowledged and (gate.get('mode') != 'restored' or gate.get('reviewRef') != review_ref): raise Refused('RESTORE_GATE_READY_FOR_ANOTHER_REVIEW')
    if not acknowledged:
        remaining = max(0, int(REPLAY_WAIT_SECONDS + REPLAY_MARGIN_SECONDS - (host.now() - gate['changedAt']/1000) + 0.999))
        if remaining: raise Refused('REPLAY_WINDOW_ACTIVE', replayRemainingSeconds=remaining)
    stopped_stack = False
    if host.unit(STACK) == 'active':
        services = host.services('backend')
        if acknowledged and healthy_backend(services):
            return {'status': 'already_open', 'services': {n: r['state'] for n, r in sorted(services.items())}}
        # An active unit would make `systemctl start` a no-op; stop it through its reviewed ExecStop.
        code, _, _ = host.run(['systemctl', 'stop', STACK])
        if code: raise Refused('STACK_STOP_FAILED')
        stopped_stack = True
    running = writers_running(host.services('backend'))
    if running: raise Refused('WRITERS_RUNNING_OUTSIDE_STACK_UNIT', writersRunning=running)
    # PostgreSQL alone: the jobs check and the acknowledgement's writer lease both need it.
    code, _, _ = host.run(['python3', '-B', LEAN+'/scripts/host.py', 'backend', 'prepare'])
    if code: raise Refused('POSTGRES_PREPARE_FAILED')
    services = host.services('backend')
    if writers_running(services): raise Refused('WRITERS_RUNNING_OUTSIDE_STACK_UNIT', writersRunning=writers_running(services))
    jobs = recovery_jobs(host, services)
    if jobs is None: raise Refused('RECOVERY_JOBS_UNREADABLE')
    if jobs['unfinished']: raise Refused('RECOVERY_JOBS_UNFINISHED', recoveryJobs=jobs)
    if not acknowledged:
        name = 'reboot-ack-'+generation+'.json'
        write_acknowledgement(host, name, {
            'version': 1, 'generation': generation, 'mode': 'restored', 'reviewRef': review_ref,
            # Enforced by wallet-control.py (stopped api/rotator) and the PostgreSQL writer lease.
            'apiAndRotatorStopped': True,
            # Operator attestations, recorded by running this command with --review-ref.
            'originalWriterCannotRestart': True, 'signerHistoryReconciled': True,
            'uncertainIntentsRetained': True, 'replayAndBudgetsConservative': True})
        code, out, err = host.run(['python3', '-B', LEAN+'/scripts/wallet-control.py', 'restore', 'acknowledge', name])
        if code:
            try: reason = json.loads(err.strip().splitlines()[-1]).get('error', '')
            except Exception: reason = ''
            raise Refused('ACKNOWLEDGEMENT_REFUSED', walletControl=reason if CODE.fullmatch(str(reason)) else 'UNKNOWN')
        gate = read_gate(host)
        if gate['state'] != 'ready' or gate['generation'] != generation or gate.get('mode') != 'restored' or gate.get('reviewRef') != review_ref:
            raise Refused('ACKNOWLEDGEMENT_NOT_RECORDED')
    services = start_stack(host, generation)
    return {'status': 'reopened', 'acknowledgedNow': not acknowledged, 'stoppedActiveStack': stopped_stack,
            'recoveryJobs': jobs, 'services': services}


def healthy_backend(services):
    return {n for n, r in services.items() if r['state'] == 'running' and r['health'] in {'', 'healthy'}} == BACKEND_SERVICES


def enable_boot(host, role):
    if role == 'pepper':
        code, _, _ = host.run(['systemctl', 'enable', 'kamui@pepper.service'])
        if code or host.unit('kamui@pepper.service', 'is-enabled') != 'enabled': raise Refused('PEPPER_ENABLE_FAILED')
        return {'status': 'enabled', 'role': 'pepper', 'unit': 'kamui@pepper.service'}
    # The fence unit has no [Install] section; add-wants is the reviewed way to run it at boot.
    # The full stack stays manual: it cannot start under a blocked gate (the API exits).
    code, _, _ = host.run(['systemctl', 'add-wants', 'multi-user.target', FENCE])
    link = host.at('/etc/systemd/system/multi-user.target.wants/'+FENCE)
    if code or not link.is_symlink(): raise Refused('BOOT_FENCE_ENABLE_FAILED')
    return {'status': 'enabled', 'role': 'backend', 'unit': FENCE, 'stackEnabled': host.unit(STACK, 'is-enabled')}


# --- Upgrading a started wallet (install/upgrade.py, setup/15-upgrade-started-release.sh) ---------

TIMERS = ['kamui-backup-check.timer', 'kamui-backup-full.timer']
BACKUP_SERVICES = ['kamui-backup@check.service', 'kamui-backup@full.service']
RECORDS = '/var/lib/kamui-install'
COMPOSE = ['docker', 'compose', '--env-file', '/etc/kamui/release.env', '-f', LEAN+'/backend/compose.yml']
HEX64 = re.compile(r'^[0-9a-f]{64}$')
TIMERS_RECORD = RECORDS+'/backend-upgrade-timers.json'
LABEL = re.compile(r'^[0-9]{8}-[0-9]{6}F$')


def installed_manifest(host, role):
    try:
        value = json.loads(host.at(RECORDS+'/'+role+'.json').read_text())
        manifest = value['manifestSha256']
        if value.get('role') != role or not HEX64.fullmatch(manifest): raise ValueError()
        return manifest
    except Exception: raise Refused('INSTALLED_RECEIPT_UNREADABLE') from None


def write_record(host, name, value):
    """Root-only, 0600, atomically replaced: the installer reads these as managed files."""
    directory = host.at(RECORDS)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077: raise Refused('INSTALL_RECORDS_DIRECTORY_INVALID')
    temporary = directory/('.'+name+'.tmp')
    if temporary.is_symlink() or temporary.exists(): temporary.unlink()
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(json.dumps(value, sort_keys=True)+'\n'); output.flush(); os.fsync(output.fileno())
    os.replace(temporary, directory/name)


def write_prepared(host, role, value): write_record(host, role+'-upgrade-prepared.json', value)


def recorded_timers(host):
    """Timers an unfinished upgrade stopped, kept across refusals and retries until 15 finish."""
    path = host.at(TIMERS_RECORD)
    if not path.exists() and not path.is_symlink(): return []
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > 4096: raise ValueError()
        timers = json.loads(path.read_text())['timers']
        if not isinstance(timers, list) or not set(timers) <= set(TIMERS): raise ValueError()
        return [t for t in TIMERS if t in timers]
    except Exception: raise Refused('UPGRADE_TIMERS_RECORD_INVALID') from None


def record_timers(host, timers):
    write_record(host, 'backend-upgrade-timers.json', {'timers': [t for t in TIMERS if t in timers]})


def restore_timers(host):
    """Start exactly the timers the upgrade stopped, then forget them."""
    started = []
    for timer in recorded_timers(host):
        if host.unit(timer) != 'active':
            if host.run(['systemctl', 'start', timer])[0]: raise Refused('BACKUP_TIMER_START_FAILED')
            started.append(timer)
    path = host.at(TIMERS_RECORD)
    if path.exists(): path.unlink()
    return started


def no_containers(host, role):
    services = host.services(role)
    if any(row['state'] not in STOPPED for row in services.values()): raise Refused('CONTAINERS_STILL_RUNNING')


def newest_full_backup(host, since):
    """Label of the newest successful full backup that finished at or after `since`."""
    code, out, _ = host.run(COMPOSE+['exec', '-T', '-u', 'postgres', 'postgres', 'pgbackrest',
                                     '--config=/etc/pgbackrest/pgbackrest.conf', '--stanza=kamui', '--output=json', 'info'])
    try:
        if code: raise ValueError()
        stanza = [x for x in json.loads(out) if x.get('name') == 'kamui'][0]
        if stanza.get('status', {}).get('code') != 0: raise ValueError()
        fulls = [b for b in stanza.get('backup', []) if b.get('type') == 'full' and int(b['timestamp']['stop']) >= since]
        label = max(fulls, key=lambda b: int(b['timestamp']['stop']))['label']
        if not LABEL.fullmatch(label): raise ValueError()
        return label
    except Exception: raise Refused('FRESH_BACKUP_NOT_FOUND') from None


def upgrade_prepare_backend(host, expected_boot):
    stopped_timers = []
    try: return prepare_backend(host, expected_boot, stopped_timers)
    except Refused as error:
        error.detail.setdefault('timersStopped', list(stopped_timers)); raise
    except Exception:
        # Never lose track of what this run stopped, whatever failed.
        raise Refused('PREPARE_FAILED', timersStopped=list(stopped_timers)) from None


def prepare_backend(host, expected_boot, stopped_timers):
    boot_id, _ = host.boot()
    if boot_id != expected_boot: raise Refused('HOST_REBOOTED_SINCE_INSPECTION')
    # Reopening afterwards relies on this boot's fence staying active (see reopen()).
    if fence_state(host, boot_id) != 'current' or host.unit(FENCE) != 'active': raise Refused('BOOT_FENCE_NOT_CURRENT_RUN_14_FENCE')
    started = int(host.now())
    previous = installed_manifest(host, 'backend')
    # Refuse before changing anything if a recovery may still be in flight.
    jobs = recovery_jobs(host, host.services('backend'))
    if jobs and jobs['unfinished']: raise Refused('RECOVERY_JOBS_UNFINISHED', recoveryJobs=jobs)
    # Record what was running before stopping anything; a retried prepare adds to the earlier record.
    active = [t for t in TIMERS if host.unit(t) == 'active']
    record_timers(host, set(recorded_timers(host)) | set(active))
    for timer in active:
        if host.run(['systemctl', 'stop', timer])[0]: raise Refused('BACKUP_TIMER_STOP_FAILED')
        stopped_timers.append(timer)
    # A running backup is a oneshot unit, reported as "activating" until it exits.
    if any(host.unit(service) not in {'inactive', 'failed'} for service in BACKUP_SERVICES):
        restore_timers(host); del stopped_timers[:]
        raise Refused('BACKUP_IN_PROGRESS_RETRY_LATER')
    # The unit's stop runs host.py down, which takes the control lock itself: stop it first.
    if host.unit(STACK) == 'active' and host.run(['systemctl', 'stop', STACK])[0]: raise Refused('STACK_STOP_FAILED')
    # Then hold the lock from the writer check until the record is written, so no host.py up or
    # gate change can slip in between the backup and the block. Child calls inherit it.
    with host.control_lock(): return prepare_stopped_backend(host, boot_id, started, previous, stopped_timers)


def prepare_stopped_backend(host, boot_id, started, previous, stopped_timers):
    if writers_running(host.services('backend')): raise Refused('WRITERS_RUNNING_OUTSIDE_STACK_UNIT')
    with host.lock_handoff(): code = host.run(['python3', '-B', LEAN+'/scripts/host.py', 'backend', 'prepare'])[0]
    if code: raise Refused('POSTGRES_PREPARE_FAILED')
    services = host.services('backend')
    if writers_running(services): raise Refused('WRITERS_RUNNING_OUTSIDE_STACK_UNIT')
    jobs = recovery_jobs(host, services)
    if jobs is None: raise Refused('RECOVERY_JOBS_UNREADABLE')
    if jobs['unfinished']: raise Refused('RECOVERY_JOBS_UNFINISHED', recoveryJobs=jobs)
    # The rollback point: a full backup taken now, with writers stopped, then checked.
    for kind in ['full', 'check']:
        code, out, _ = host.run(['bash', '-c', 'set -a; . /etc/kamui/backup/operator.settings; set +a; exec '+LEAN+'/backup/backup.sh '+kind])
        last = out.strip().splitlines()[-1] if out.strip() else ''
        if code or '"status":"backup-complete"' not in last: raise Refused('BACKUP_'+kind.upper()+'_FAILED')
    label = newest_full_backup(host, started)
    # Writers stay out until the operator reopens them, exactly as after a reboot.
    # wallet-control refuses to block while a writer runs, so a writer started in an older release's
    # brief handoff cannot slip past the block unnoticed.
    with host.lock_handoff(): code, _, _ = host.run(['python3', '-B', LEAN+'/scripts/wallet-control.py', 'restore', 'block'])
    gate = read_gate(host)
    if code or gate['state'] != 'blocked' or gate['reason'] != 'restore': raise Refused('RESTORE_GATE_BLOCK_FAILED')
    with host.lock_handoff(): code = host.run(['python3', '-B', LEAN+'/scripts/host.py', 'backend', 'down'])[0]
    if code: raise Refused('STACK_DOWN_FAILED')
    no_containers(host, 'backend')
    prepare_id = str(uuid.uuid4())
    write_prepared(host, 'backend', {'schema': 'kamui.upgrade-prepared.v1', 'role': 'backend', 'prepareId': prepare_id, 'bootId': boot_id,
                                     'preparedAt': int(host.now()), 'previousManifestSha256': previous,
                                     'backupLabel': label, 'gateGeneration': gate['generation']})
    return {'status': 'upgrade_prepared', 'role': 'backend', 'prepareId': prepare_id, 'backupLabel': label,
            'gateGeneration': gate['generation'], 'timersStopped': list(stopped_timers), 'recoveryJobs': jobs}


def upgrade_prepare_pepper(host, expected_boot):
    boot_id, _ = host.boot()
    if boot_id != expected_boot: raise Refused('HOST_REBOOTED_SINCE_INSPECTION')
    previous = installed_manifest(host, 'pepper')
    if host.unit('kamui@pepper.service') == 'active' and host.run(['systemctl', 'stop', 'kamui@pepper.service'])[0]: raise Refused('STACK_STOP_FAILED')
    with host.control_lock():
        no_containers(host, 'pepper')
        prepare_id = str(uuid.uuid4())
        write_prepared(host, 'pepper', {'schema': 'kamui.upgrade-prepared.v1', 'role': 'pepper', 'prepareId': prepare_id, 'bootId': boot_id,
                                        'preparedAt': int(host.now()), 'previousManifestSha256': previous})
    return {'status': 'upgrade_prepared', 'role': 'pepper', 'prepareId': prepare_id}


def upgrade_finish(host, role):
    if role == 'pepper':
        if host.unit('kamui@pepper.service') != 'active' and host.run(['systemctl', 'start', 'kamui@pepper.service'])[0]: raise Refused('STACK_START_FAILED')
        state = inspect_pepper(host)
        if not state['healthy']: raise Refused('STACK_NOT_HEALTHY_AFTER_START')
        return {'status': 'upgrade_finished', 'role': 'pepper', 'services': state['services']}
    gate = read_gate(host)
    if gate['state'] != 'ready': return {'status': 'awaiting_reopen', 'role': 'backend'}
    services = host.services('backend')
    if host.unit(STACK) != 'active' or not healthy_backend(services):
        # The gate was never blocked (a prepare refused early): writes were never closed, so the
        # stack restarts without a new attestation. start_stack refuses if the gate changes.
        start_stack(host, gate['generation'])
        services = host.services('backend')
    # Exactly the timers prepare stopped (enabled or not), never others the operator left stopped.
    started = restore_timers(host)
    return {'status': 'upgrade_finished', 'role': 'backend', 'timersStarted': started,
            'services': {n: r['state'] for n, r in sorted(services.items())}}


def main(argv, host=None):
    host = host or Host()
    try:
        if os.geteuid() != 0 and host.root == Path('/'): raise Refused('ROOT_REQUIRED')
        action, args = argv[0], argv[1:]
        if action == 'inspect' and args == ['backend']: result = {'status': 'inspected', **inspect_backend(host)}
        elif action == 'inspect' and args == ['pepper']: result = {'status': 'inspected', **inspect_pepper(host)}
        elif action == 'fence' and len(args) == 1: result = fence(host, args[0])
        elif action == 'reopen' and len(args) == 3: result = reopen(host, *args)
        elif action == 'enable-boot' and len(args) == 1 and args[0] in {'backend', 'pepper'}: result = enable_boot(host, args[0])
        elif action == 'upgrade-prepare' and len(args) == 2 and args[0] == 'backend': result = upgrade_prepare_backend(host, args[1])
        elif action == 'upgrade-prepare' and len(args) == 2 and args[0] == 'pepper': result = upgrade_prepare_pepper(host, args[1])
        elif action == 'upgrade-finish' and len(args) == 1 and args[0] in {'backend', 'pepper'}: result = upgrade_finish(host, args[0])
        else: raise Refused('HOST_ACTION_INVALID')
    except Refused as error:
        result = {'status': 'refused', 'code': error.code, **error.detail}
    except Exception:
        result = {'status': 'refused', 'code': 'HOST_PROGRAM_FAILED'}
    print(RESULT+json.dumps(result, sort_keys=True), flush=True)
    return result


if __name__ == '__main__':
    main(sys.argv[1:])
