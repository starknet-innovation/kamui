#!/usr/bin/env python3
"""Run fixed control CLIs in a no-signing-secret container while API is stopped."""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('kamui_host', ROOT/'scripts/host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


def input_file(value):
    if not re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9_.-]{0,100}', value):
        raise ValueError('OPERATOR_INPUT_FILENAME_INVALID')
    return '/run/kamui/operator/' + value


def main():
    args = sys.argv[1:]
    if not args:
        raise ValueError('OPERATOR_USAGE')
    if args[0] == 'restore' and len(args) == 2 and args[1] in {'initialize','block','status'}:
        script = ['restore-control.ts',args[1]]
    elif args[0] == 'restore' and len(args) == 3 and args[1] == 'acknowledge':
        script = ['restore-control.ts','acknowledge',input_file(args[2])]
    elif args[0] == 'spending' and len(args) == 2 and args[1] in {'pause','resume','status'}:
        script = ['spending-control.ts','--api-stopped',args[1]]
    elif args[0] == 'migrate' and len(args) == 3:
        script = ['migrate-postgres.ts','--api-stopped',input_file(args[1]),input_file(args[2])]
    else:
        raise ValueError('OPERATOR_USAGE')
    config = Path(os.environ.get('CONFIG_DIRECTORY','/etc/kamui'))
    state = Path(os.environ.get('STATE_DIRECTORY','/var/lib/kamui'))
    images = host.release(config/'release.env','backend')
    env = {**os.environ,**images,'CONFIG_DIRECTORY':str(config),'STATE_DIRECTORY':str(state),'POSTGRES_DATA_DIRECTORY':host.canonical_data_directory(state)}
    with host.control_lock(state):
        command = ['docker','compose','--env-file',str(config/'release.env'),'-f',str(ROOT/'backend/compose.yml'),'--profile','operator']
        # The DB lease refuses an API using this database. Also refuse a running rotator:
        # a restore/spending operator must not race any paid writer or its supervisor.
        checked = subprocess.run(command+['ps','--all','--format','json'],env=env,capture_output=True,text=True)
        if checked.returncode:
            raise ValueError('OPERATOR_STATUS_FAILED')
        raw = checked.stdout.strip()
        rows = json.loads(raw) if raw.startswith('[') else [json.loads(line) for line in raw.splitlines() if line]
        host.assert_writers_stopped(rows)
        run = subprocess.run(command+['run','--rm','--no-deps','-T','operator','bun','run','src/scripts/'+script[0],*script[1:]],env=env,capture_output=True,text=True)
        if run.returncode:
            raise ValueError('OPERATOR_COMMAND_REFUSED')
        allowed = {'status','generation','mode','paused','sessions','usedMessages','recoveryJobs','recoveryMetadata'}
        result = json.loads(run.stdout.strip())
        print(json.dumps({key:value for key,value in result.items() if key in allowed}))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error,ValueError) and re.fullmatch('[A-Z_]{3,60}',str(error)) else 'OPERATOR_COMMAND_FAILED'
        print(json.dumps({'status':'refused','error':code}),file=sys.stderr)
        sys.exit(1)
