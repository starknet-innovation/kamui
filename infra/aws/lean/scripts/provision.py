#!/usr/bin/env python3
"""Operator-only, one-shot EC2 launch using already reviewed existing resources.

Never creates network/IAM objects. An exclusive durable intent prevents resubmission
following uncertainty; reconcile its ClientToken rather than deleting that intent.
"""
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import uuid


def environment():
    blocked = {'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
               'AWS_SECURITY_TOKEN', 'AWS_ROLE_ARN', 'AWS_ROLE_SESSION_NAME',
               'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
               'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_AUTHORIZATION_TOKEN',
               'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE'}
    result = {k: v for k, v in os.environ.items() if k not in blocked and not k.startswith('AWS_ENDPOINT_URL')}
    result.update(AWS_MAX_ATTEMPTS='1', AWS_RETRY_MODE='standard', AWS_EC2_METADATA_DISABLED='true',
                  AWS_IGNORE_CONFIGURED_ENDPOINT_URLS='true', AWS_PAGER='', AWS_CLI_AUTO_PROMPT='off')
    return result


def private_file(path, value):
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(json.dumps(value, indent=2) + '\n'); output.flush(); os.fsync(output.fileno())


def sync(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


def validate(values):
    if values.get('KAMUI_INFRA_REVIEWED') != 'yes': raise ValueError('INFRA_REVIEW_REQUIRED')
    role = values.get('KAMUI_ROLE')
    if role not in {'backend', 'pepper'}: raise ValueError('HOST_ROLE_REQUIRED')
    for key, pattern in {
        'AWS_PROFILE': r'[A-Za-z0-9_.-]{1,128}', 'EXPECTED_ACCOUNT': r'\d{12}',
        'AMI_ID': r'ami-[0-9a-f]{8,17}', 'SUBNET_ID': r'subnet-[0-9a-f]{8,17}',
        'SECURITY_GROUP_ID': r'sg-[0-9a-f]{8,17}', 'INSTANCE_PROFILE_NAME': r'[A-Za-z0-9+=,.@_-]{1,128}',
        'ROOT_DEVICE_NAME': r'/dev/[A-Za-z0-9._/-]{1,64}',
    }.items():
        if not re.fullmatch(pattern, values.get(key, '')): raise ValueError('PROVISION_INPUT_INVALID')
    directory = Path(values.get('OPERATOR_PRIVATE_DIRECTORY', ''))
    if not directory.is_absolute() or directory.resolve() != directory: raise ValueError('PRIVATE_DIRECTORY_REQUIRED')
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('PRIVATE_DIRECTORY_REQUIRED')
    return role, directory


def run(values, execute=subprocess.run):
    role, directory = validate(values)
    # Refuse even an empty previous intent: it may precede a submitted launch.
    intent = directory/(role + '-launch-intent.json')
    if intent.exists() or intent.is_symlink(): raise ValueError('LAUNCH_INTENT_EXISTS_RECONCILE_ONLY')
    common = ['--profile', values['AWS_PROFILE'], '--region', 'eu-west-1', '--output', 'json',
              '--no-cli-pager', '--no-cli-auto-prompt', '--cli-connect-timeout', '5', '--cli-read-timeout', '15']
    # Identity output/errors stay private. Never use a value just read as its own expected identity.
    with open(directory/(role+'-identity.json'), 'xb') as identity, open(directory/(role+'-identity.log'), 'xb') as errors:
        os.chmod(identity.name, 0o600); os.chmod(errors.name, 0o600)
        result = execute(['aws', 'sts', 'get-caller-identity', *common], stdout=identity, stderr=errors,
                         timeout=40, env=environment())
    if result.returncode: raise ValueError('ACCOUNT_CHECK_UNAVAILABLE')
    if json.loads((directory/(role+'-identity.json')).read_text()).get('Account') != values['EXPECTED_ACCOUNT']:
        raise ValueError('EXPECTED_ACCOUNT_MISMATCH')
    size, disk = ('t3.medium', 30) if role == 'backend' else ('t3.micro', 10)
    payload = {'ImageId': values['AMI_ID'], 'InstanceType': size, 'MinCount': 1, 'MaxCount': 1,
               'ClientToken': 'kamui-'+role+'-'+str(uuid.uuid4()),
               'NetworkInterfaces': [{'DeviceIndex': 0, 'SubnetId': values['SUBNET_ID'],
                                      'Groups': [values['SECURITY_GROUP_ID']], 'AssociatePublicIpAddress': True}],
               'IamInstanceProfile': {'Name': values['INSTANCE_PROFILE_NAME']},
               'MetadataOptions': {'HttpTokens': 'required', 'HttpPutResponseHopLimit': 2, 'HttpEndpoint': 'enabled'},
               'CreditSpecification': {'CpuCredits': 'standard'},
               'BlockDeviceMappings': [{'DeviceName': values['ROOT_DEVICE_NAME'], 'Ebs': {
                   'VolumeSize': disk, 'VolumeType': 'gp3', 'Encrypted': True, 'DeleteOnTermination': False}}],
               'TagSpecifications': [{'ResourceType': 'instance', 'Tags': [
                   {'Key': 'Project', 'Value': 'kamui'}, {'Key': 'Role', 'Value': role}, {'Key': 'Network', 'Value': 'sepolia'}]}]}
    private_file(intent, payload); sync(directory)
    # No retry loop. Even rejected/timeout responses retain the exact token and request.
    with open(directory/(role+'-instance.json'), 'xb') as output, open(directory/(role+'-provision.log'), 'xb') as errors:
        os.chmod(output.name, 0o600); os.chmod(errors.name, 0o600)
        result = execute(['aws', 'ec2', 'run-instances', *common, '--cli-input-json', 'file://'+str(intent)],
                         stdout=output, stderr=errors, timeout=45, env=environment())
        output.flush(); errors.flush(); os.fsync(output.fileno()); os.fsync(errors.fileno())
    sync(directory)
    if result.returncode: raise ValueError('LAUNCH_UNCERTAIN_RECONCILE_PRIVATE_INTENT')
    response = json.loads((directory/(role+'-instance.json')).read_text())
    if len(response.get('Instances', [])) != 1: raise ValueError('LAUNCH_UNCERTAIN_RECONCILE_PRIVATE_INTENT')
    print('INSTANCE_RESULT_SAVED_PRIVATELY')


if __name__ == '__main__':
    try: run(os.environ)
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch('[A-Z_]{3,80}', str(error)) else 'PROVISION_STOPPED_KEEP_PRIVATE_OUTPUTS'
        print(code); raise SystemExit(1)
