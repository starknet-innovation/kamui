#!/usr/bin/env python3
"""Root-only. Keep Kamui containers off the instance metadata service, except the one that needs it.

The instance role can read this host's runtime secrets, including the relayer key on backend.
Bridge-networked containers would otherwise reach the metadata service and borrow that role, so an
internet-facing container such as Caddy or the keychain could read them. Only the backup network
(backend: pgBackRest to S3) and the KMS network (pepper: HMAC) may reach it. Every other container
network is dropped, including any added later.

Runs before every stack start (kamui-imds-guard@<role>.service) and is idempotent. If the rules
cannot be put in place the unit fails, and the stack does not start.
"""
import json
import re
import subprocess
import sys

IMDS = '169.254.169.254/32'
CHAIN = 'KAMUI-IMDS'
# Must match the fixed subnets in backend/compose.yml and pepper/compose.yml.
ALLOWED = {'backend': '10.199.250.0/24', 'pepper': '10.199.251.0/24'}


def expected_chain(role):
    return ['-N '+CHAIN, '-A '+CHAIN+' -s '+ALLOWED[role]+' -j RETURN', '-A '+CHAIN+' -j DROP']


def iptables(args):
    """Returns (returncode, stdout). Tests replace this with a fake firewall."""
    try: answer = subprocess.run(['iptables', '-w', *args], capture_output=True, timeout=30)
    except Exception: raise ValueError('FIREWALL_UNAVAILABLE') from None
    return answer.returncode, answer.stdout.decode()


def guard(role, command=iptables):
    def run(args, check=True):
        code, output = command(args)
        if check and code: raise ValueError('FIREWALL_COMMAND_FAILED')
        return code, output
    def listed(chain):
        code, output = run(['-S', chain], check=False)
        return output.splitlines() if code == 0 else None
    if role not in ALLOWED: raise ValueError('ROLE_INVALID')
    # DOCKER-USER exists once Docker has started; the unit is ordered after docker.service.
    if listed('DOCKER-USER') is None: raise ValueError('DOCKER_FIREWALL_CHAIN_MISSING')
    current = listed(CHAIN)
    if current != expected_chain(role):
        if current is None: run(['-N', CHAIN])
        # The containers are not running yet when this unit runs, so rebuilding the chain in place
        # has no window in which a running container could reach the metadata service.
        run(['-F', CHAIN])
        run(['-A', CHAIN, '-s', ALLOWED[role], '-j', 'RETURN'])
        run(['-A', CHAIN, '-j', 'DROP'])
    jump = ['-d', IMDS, '-j', CHAIN]
    if run(['-C', 'DOCKER-USER', *jump], check=False)[0]:
        run(['-I', 'DOCKER-USER', '1', *jump])
    if listed(CHAIN) != expected_chain(role) or run(['-C', 'DOCKER-USER', *jump], check=False)[0]:
        raise ValueError('FIREWALL_NOT_IN_PLACE')
    return {'status': 'metadata_service_restricted', 'role': role, 'allowedSubnet': ALLOWED[role]}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2: raise ValueError('ROLE_REQUIRED')
        print(json.dumps(guard(sys.argv[1])))
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch('[A-Z_]{3,100}', str(error)) else 'FIREWALL_GUARD_FAILED'
        print(code); raise SystemExit(1)
