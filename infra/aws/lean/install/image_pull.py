#!/usr/bin/env python3
"""Host-only immutable image retrieval. No container/service startup or runtime files."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile

KEYS = {'backend': ['CADDY_IMAGE', 'KEYCHAIN_IMAGE', 'BACKEND_IMAGE', 'POSTGRES_IMAGE'],
        'pepper': ['CADDY_IMAGE', 'PEPPER_IMAGE']}


def run_images(role, manifest_path, expected_hash, docker_config, verify=False, execute=subprocess.run):
    if role not in KEYS or not re.fullmatch('[a-f0-9]{64}', expected_hash): raise ValueError('IMAGE_REVIEW_PIN_REQUIRED')
    source = Path(manifest_path)
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 262144: raise ValueError('IMAGE_MANIFEST_INVALID')
        raw = os.read(fd, 262145)
    finally: os.close(fd)
    if hashlib.sha256(raw).hexdigest() != expected_hash: raise ValueError('IMAGE_MANIFEST_CHANGED')
    value = json.loads(raw)
    if value.get('schema') != 'kamui.host-install.v1' or value.get('role') != role: raise ValueError('IMAGE_ROLE_CHANGED')
    images = [value['releaseImages'][key] for key in KEYS[role]]
    for image in images:
        if not re.fullmatch(r'[0-9]{12}\.dkr\.ecr\.eu-west-1\.amazonaws\.com/kamui-sepolia/[a-z]+@sha256:[a-f0-9]{64}', image):
            raise ValueError('IMAGE_IMMUTABLE_ECR_REFERENCE_REQUIRED')
    registries = {image.split('/')[0] for image in images}
    if len(registries) != 1: raise ValueError('IMAGE_REGISTRY_MISMATCH')
    config = Path(docker_config)
    if not config.is_absolute() or config.resolve() != config: raise ValueError('IMAGE_PRIVATE_CONFIG_REQUIRED')
    config.mkdir(mode=0o700, exist_ok=True)
    info = config.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('IMAGE_PRIVATE_CONFIG_REQUIRED')
    with tempfile.TemporaryDirectory(prefix='ecr-auth-', dir=config) as auth:
        environment = {k:v for k,v in os.environ.items() if not k.startswith('AWS_') and k != 'DOCKER_CONFIG'}
        environment.update(AWS_CONFIG_FILE='/dev/null', AWS_SHARED_CREDENTIALS_FILE='/dev/null',
            AWS_EC2_METADATA_DISABLED='false', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS='true',
            AWS_MAX_ATTEMPTS='1', AWS_DEFAULT_REGION='eu-west-1', DOCKER_CONFIG=auth)
        def run(args, data=None):
            try: answer = execute(args, input=data, capture_output=True, env=environment, timeout=600)
            except Exception: raise ValueError('IMAGE_OPERATION_FAILED_PRIVATE_DIAGNOSIS_REQUIRED') from None
            if answer.returncode: raise ValueError('IMAGE_OPERATION_FAILED_PRIVATE_DIAGNOSIS_REQUIRED')
            return answer.stdout
        docker = ['docker', '--config', auth]
        if not verify:
            password = run(['aws', 'ecr', 'get-login-password', '--region', 'eu-west-1', '--no-cli-pager'])
            if not password or len(password) > 16384: raise ValueError('IMAGE_AUTH_UNAVAILABLE')
            run(docker+['login', '--username', 'AWS', '--password-stdin', next(iter(registries))], password)
            del password
            for image in images: run(docker+['pull', '--platform', 'linux/amd64', image])
        for image in images:
            raw = run(docker+['image', 'inspect', '--format', '{{json .RepoDigests}}', image])
            try: digests = json.loads(raw)
            except Exception: raise ValueError('IMAGE_LOCAL_DIGEST_INVALID') from None
            if not isinstance(digests, list) or image not in digests: raise ValueError('IMAGE_LOCAL_DIGEST_MISMATCH')
    return {'imagesVerified': len(images), 'containersStarted': False, 'persistentCredentialsInstalled': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--role', choices=sorted(KEYS), required=True)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--docker-config', required=True)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    try: print(json.dumps(run_images(args.role, args.manifest, args.manifest_sha256, args.docker_config, args.check)))
    except Exception: print('IMMUTABLE_IMAGE_STEP_FAILED'); raise SystemExit(1)
