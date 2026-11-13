#!/usr/bin/env python3
"""Approve an app for sponsored calls (setup/16-register-sponsored-app.sh). Operator-run, local only.

  register <app-key>   create the app's server credential in a private file (never printed) and add
                       the app, with its limits, to the funding policy in installation/runtime-decisions.json
  status               list approved app keys and where each credential file is

Nothing reaches the hosts until 08, 13 and `14 reload-runtime`. The credential goes to the app's
own server (SPONSOR_SERVER_TOKEN_FILE), never to a browser, Git or the policy: the policy holds only
its SHA-256. Approving an app does not authenticate its users; its server decides who may spend.
"""
import argparse
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets

from common import private_dir
import runtime

# Sepolia defaults: within the sponsor operation's own bounds, which still apply on top.
LIMITS = {'periodSeconds': 3600, 'txPerPeriod': 500, 'perAccountPerPeriod': 50, 'maxFeePerTx': '20000000000000000000',
          'maxFeePerPeriod': '1000000000000000000000', 'perAccountMaxFeePerPeriod': '200000000000000000000'}


def credential_path(root, key):
    return private_dir(private_dir(Path(root)/'apps')/key)/'sponsor-token'


def register(root, key):
    if not runtime.APP_KEY.fullmatch(key): raise ValueError('SPONSOR_APP_KEY_INVALID')
    path = Path(root)/'installation'/runtime.DECISIONS
    decisions = runtime.load_decisions(root)
    policy = decisions.get('funding', {}).get('policy')
    if policy is None: raise ValueError('SPONSOR_FUNDING_POLICY_NOT_DECIDED')
    token_file = credential_path(root, key)
    if token_file.exists() or token_file.is_symlink():
        token = runtime.read(token_file).decode().strip()
        if not re.fullmatch(r'[A-Za-z0-9_-]{64}', token): raise ValueError('SPONSOR_CREDENTIAL_FILE_INVALID')
    else:
        token = secrets.token_urlsafe(48)
        runtime.write(token_file, token+'\n')
    digest = hashlib.sha256(token.encode()).hexdigest()
    existing = policy['apps'].get(key)
    if existing and existing['credentialHash'] != digest: raise ValueError('SPONSOR_APP_REGISTERED_WITH_ANOTHER_CREDENTIAL')
    updated = copy.deepcopy(decisions)
    updated['funding']['policy']['apps'][key] = existing or {**LIMITS, 'credentialHash': digest}
    runtime.validate_decisions(updated)
    if updated != decisions:
        runtime.update(path, json.dumps(updated, indent=2)+'\n', Path(root)/'installation/runtime-history', 'runtime-decisions.json')
    return {'status': 'SPONSOR_APP_ALREADY_REGISTERED' if existing else 'SPONSOR_APP_REGISTERED_RUN_08_13_14_RELOAD',
            'appKey': key, 'credentialFile': str(token_file), 'limits': {k: v for k, v in (existing or LIMITS).items() if k != 'credentialHash'}}


def status(root):
    apps = runtime.load_decisions(root).get('funding', {}).get('policy', {}).get('apps', {})
    return {'status': 'SPONSOR_APPS', 'apps': {key: str(credential_path(root, key)) for key in sorted(apps)}}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', choices=['register', 'status'])
    parser.add_argument('app_key', nargs='?')
    parser.add_argument('--private-directory', default=str(Path.home()/'.kamui-hosting-sepolia'))
    options = parser.parse_args()
    if (options.action == 'register') != (options.app_key is not None): raise ValueError('SPONSOR_APP_KEY_REQUIRED_FOR_REGISTER_ONLY')
    root = private_dir(options.private_directory)
    directory = private_dir(root/'installation')
    descriptor = os.open(directory/'.installation.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try: fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise ValueError('INSTALLATION_LOCK_BUSY') from None
        print(json.dumps(register(root, options.app_key) if options.action == 'register' else status(root)))
    finally: os.close(descriptor)


if __name__ == '__main__':
    try: main()
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch('[A-Z0-9_]{3,100}', str(error)) else 'SPONSOR_APP_STOPPED'
        print(code); raise SystemExit(1)
