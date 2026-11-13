#!/usr/bin/env python3
"""Operator-run upgrade of a started wallet (setup/15-upgrade-started-release.sh).

Once a wallet has started, the host installer refuses a new release unless this procedure has
prepared the host. Order, from infra/aws/lean/setup on a clean checkout of the release source:

  11, then 07, 08 and 13 as for any release     build the new release locally
  15 prepare                                    backend first: fresh full backup, restore gate
                                                blocked; then pepper stopped (downtime starts)
  15 install                                    09 with --upgrade-started on both hosts
  10                                            verify
  15 finish                                     start pepper
  14 reopen --review-ref <ref>                  reopen backend writes on your attestation
  15 finish                                     restart the backup timers

The host side is install/reopen_host.py (actions upgrade-prepare / upgrade-finish), sent inline
through SSM. Nothing in the installed host package is used to decide the upgrade itself.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import sys

from common import Aws, AwsError, Driver, private_dir, read_private, write_private
import install
from reopen import Reopen

CONFIRMATION = 'UPGRADE'


def ask(prompt):
    if not sys.stdin.isatty(): raise ValueError('UPGRADE_INTERACTIVE_CONFIRMATION_REQUIRED')
    return input(prompt)


class Upgrade(Reopen):
    def __init__(self, root, driver, aws=None, deliver=install.deliver, confirm=ask, out=print, **kwargs):
        super().__init__(root, driver, confirm=confirm, out=out, **kwargs)
        self.root, self.aws, self.deliver = Path(root), aws, deliver
        self.prepared_path = private_dir(private_dir(self.root/'installation')/'upgrade')/'prepared.json'

    def local_release_ready(self):
        """A superseded release and a newly built one: 11 then 07 have run."""
        if not install.superseded(self.root): raise ValueError('UPGRADE_RUN_11_THEN_07_FIRST')
        release = self.root/'installation/release/release.json'
        if not release.exists(): raise ValueError('UPGRADE_RUN_07_FIRST')
        revision = json.loads(read_private(release)).get('sourceRevision', '')
        if not re.fullmatch('[a-f0-9]{40}', revision): raise ValueError('UPGRADE_RELEASE_INVALID')
        return revision

    def prepare(self):
        revision = self.local_release_ready()
        backend, pepper = self.inspect('backend'), self.inspect('pepper')
        self.evidence('upgrade-inspect', {'backend': backend, 'pepper': pepper})
        jobs = backend.get('recoveryJobs')
        if jobs and jobs['unfinished']: raise ValueError('UPGRADE_RECOVERY_JOBS_UNFINISHED')
        if backend['fence'] != 'current' or backend['fenceUnit'] != 'active': raise ValueError('UPGRADE_BOOT_FENCE_NOT_CURRENT_RUN_14_FENCE')
        self.out('Upgrading both hosts to release '+revision[:12]+'.')
        self.out('  Both stacks stop now. The site and pepper are down until `15 install` and `15 finish`;')
        self.out('  backend writes stay closed until `14 reopen` (at least the 10-minute replay window).')
        self.out('  The backend takes a fresh full backup first: it is the rollback point.')
        if self.confirm('Type '+CONFIRMATION+' to stop the hosts and prepare the upgrade: ').strip() != CONFIRMATION:
            raise ValueError('UPGRADE_NOT_CONFIRMED')
        # A previous run's ids must never reach this run's install.
        if self.prepared_path.exists(): self.prepared_path.unlink()
        results, ids = {}, {}
        # Backend first: if it refuses, pepper has not been touched.
        for role, state in [('backend', backend), ('pepper', pepper)]:
            result = self.call(role, 'upgrade-prepare', 'upgrade-prepare', role, state['bootId'])
            self.evidence('upgrade-prepare-'+role, result)
            if result['status'] == 'refused':
                if result.get('timersStopped'): self.out('BACKUP_TIMERS_LEFT_STOPPED '+' '.join(result['timersStopped']))
                self.out('RECOVER_WITH_15_FINISH_OR_SEE_UPGRADE_MD')
                raise ValueError(('UPGRADE_PREPARE_'+role.upper()+'_'+result['code'])[:100])
            if not re.fullmatch(r'[0-9a-f-]{36}', str(result.get('prepareId'))): raise ValueError('UPGRADE_PREPARE_ID_MISSING')
            ids[role] = result['prepareId']
            results[role] = {k: result[k] for k in ['backupLabel', 'timersStopped'] if k in result}
        write_private(self.prepared_path, {'release': revision, 'prepareIds': ids})
        return {'status': 'UPGRADE_PREPARED_RUN_15_INSTALL_WITHIN_ONE_HOUR', 'release': revision[:12], **results}

    def install(self):
        revision = self.local_release_ready()
        if not self.prepared_path.exists(): raise ValueError('UPGRADE_NOT_PREPARED_RUN_15_PREPARE')
        prepared = json.loads(read_private(self.prepared_path))
        if prepared.get('release') != revision or set(prepared.get('prepareIds', {})) != {'backend', 'pepper'}:
            raise ValueError('UPGRADE_PREPARED_FOR_ANOTHER_RELEASE_RERUN_15_PREPARE')
        # Each prepare yields new ids, so a retry after any refusal is a new, bound install command.
        result = self.deliver(self.root, self.aws, self.driver, upgrade=prepared['prepareIds'])
        return {'status': 'UPGRADE_INSTALLED_RUN_10_THEN_15_FINISH', **result}

    def finish(self):
        results = {}
        for role in ['pepper', 'backend']:
            result = self.call(role, 'upgrade-finish', 'upgrade-finish', role)
            self.evidence('upgrade-finish-'+role, result)
            if result['status'] == 'refused': raise ValueError(('UPGRADE_FINISH_'+role.upper()+'_'+result['code'])[:100])
            results[role] = {k: result[k] for k in ['status', 'timersStarted', 'services'] if k in result}
        done = results['backend']['status'] == 'upgrade_finished'
        return {'status': 'UPGRADE_FINISHED' if done else 'PEPPER_STARTED_RUN_14_REOPEN_THEN_15_FINISH_AGAIN', **results}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', choices=['prepare', 'install', 'finish'])
    parser.add_argument('--private-directory', default=str(Path.home()/'.kamui-hosting-sepolia'))
    options = parser.parse_args()
    root = private_dir(options.private_directory)
    directory = private_dir(root/'installation')
    descriptor = os.open(directory/'.installation.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try: fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise ValueError('INSTALLATION_LOCK_BUSY') from None
        print('STEP_UPGRADE_'+options.action.upper(), flush=True)
        aws = Aws(root)
        tool = Upgrade(root, Driver(root, aws), aws)
        print(json.dumps(getattr(tool, options.action)()))
    finally: os.close(descriptor)


if __name__ == '__main__':
    try: main()
    except Exception as error:
        code = str(error) if isinstance(error, (ValueError, AwsError)) and re.fullmatch('[A-Z_]{3,100}', str(error)) else 'UPGRADE_STOPPED_PRIVATE_EVIDENCE_RETAINED'
        print(code); raise SystemExit(1)
