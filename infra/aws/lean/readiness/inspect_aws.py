#!/usr/bin/env python3
"""Operator-run read-only inventory. Prints fixed check labels, never resource values.

This is a configuration observation, not an IAM/security audit or permission to deploy.
It never reads a signing key, secret value, key material or AWS credential file itself.
"""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess

REGION = 'eu-west-1'
READS = {
    ('sts', 'get-caller-identity'), ('ec2', 'describe-images'),
    ('ec2', 'describe-subnets'), ('ec2', 'describe-route-tables'),
    ('ec2', 'describe-security-groups'), ('iam', 'get-instance-profile'),
    ('kms', 'describe-key'), ('s3api', 'head-bucket'),
    ('s3api', 'get-public-access-block'), ('s3api', 'get-bucket-encryption'),
}
ROLE_KEYS = {'aws_profile', 'expected_account', 'ami_id', 'approved_ami_owner',
             'subnet_id', 'security_group_id', 'instance_profile_name'}


def load_private(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 65536:
            raise ValueError('PRIVATE_INPUT_REQUIRED')
        raw = os.read(fd, 65537)
        if len(raw) > 65536:
            raise ValueError('PRIVATE_INPUT_REQUIRED')
        return json.loads(raw)
    finally:
        os.close(fd)


def validate(config):
    if not isinstance(config, dict) or set(config) != {'version', 'region', 'backend', 'pepper'} or config['version'] != 1 or config['region'] != REGION:
        raise ValueError('INPUT_INVALID')
    for role in ['backend', 'pepper']:
        values = config[role]
        allowed = ROLE_KEYS | ({'backup_bucket'} if role == 'backend' else {'pepper_key_id'})
        if not isinstance(values, dict) or set(values) != allowed or any(not isinstance(v, str) or not v for v in values.values()):
            raise ValueError('INPUT_INVALID')
        if not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', values['aws_profile']):
            raise ValueError('INPUT_INVALID')
        if not re.fullmatch(r'\d{12}', values['expected_account']) or not re.fullmatch(r'\d{12}', values['approved_ami_owner']):
            raise ValueError('INPUT_INVALID')
    # DescribeKey on certain AWS-managed aliases can create a key. Only inspect the
    # explicit existing customer key ARN selected privately by the owner, never aliases.
    match = re.fullmatch(r'arn:aws[a-z-]*:kms:eu-west-1:(\d{12}):key/[A-Za-z0-9-]+', config['pepper']['pepper_key_id'])
    if not match or match[1] != config['pepper']['expected_account']:
        raise ValueError('EXISTING_PEPPER_KEY_REQUIRED')


class Aws:
    def request(self, profile, service, operation, inputs):
        if (service, operation) not in READS:
            raise ValueError('READ_OPERATION_REQUIRED')
        # Resource references go through stdin, not shell interpolation or argv.
        args = ['aws', service, operation, '--profile', profile, '--region', REGION,
                '--output', 'json', '--no-cli-pager', '--no-cli-auto-prompt',
                '--cli-input-json', 'file:///dev/stdin']
        result = subprocess.run(args, input=json.dumps(inputs), capture_output=True,
                                text=True, timeout=40,
                                env={**os.environ, 'AWS_PAGER': '', 'AWS_CLI_AUTO_PROMPT': 'off'})
        if result.returncode:
            raise RuntimeError('AWS_READ_UNAVAILABLE')
        return json.loads(result.stdout or '{}')


def web_ingress_only(group):
    ports = set()
    for permission in group.get('IpPermissions', []):
        if permission.get('IpProtocol') != 'tcp' or permission.get('FromPort') != permission.get('ToPort') or permission.get('FromPort') not in {80, 443}:
            return False
        ports.add(permission['FromPort'])
    return ports == {80, 443}


def inspect(config, client):
    validate(config)
    checks = {}
    accounts = {}
    def check(label, profile, service, operation, inputs, predicate):
        try:
            data = client.request(profile, service, operation, inputs)
            passed = bool(predicate(data))
            checks[label] = 'pass' if passed else 'fail'
            return data if passed else None
        except Exception:
            checks[label] = 'unavailable'
            return None
    for role in ['backend', 'pepper']:
        values = config[role]
        profile = values['aws_profile']
        identity = check(role + '_account_matches', profile, 'sts', 'get-caller-identity', {},
                         lambda data: data.get('Account') == values['expected_account'])
        if not identity:
            continue  # Do not inspect resources through an unexpected account/profile.
        accounts[role] = identity['Account']
        check(role + '_reviewed_ami_shape', profile, 'ec2', 'describe-images', {'ImageIds': [values['ami_id']]},
              lambda data: len(data.get('Images', [])) == 1 and data['Images'][0].get('Architecture') == 'x86_64'
              and data['Images'][0].get('State') == 'available' and data['Images'][0].get('RootDeviceType') == 'ebs'
              and data['Images'][0].get('OwnerId') == values['approved_ami_owner']
              and data['Images'][0].get('ImageAllowed', True))
        subnet = check(role + '_subnet_available', profile, 'ec2', 'describe-subnets', {'SubnetIds': [values['subnet_id']]},
                       lambda data: len(data.get('Subnets', [])) == 1 and data['Subnets'][0].get('State') == 'available' and bool(data['Subnets'][0].get('VpcId')))
        group = check(role + '_web_ingress_shape', profile, 'ec2', 'describe-security-groups', {'GroupIds': [values['security_group_id']]},
                      lambda data: len(data.get('SecurityGroups', [])) == 1 and bool(data['SecurityGroups'][0].get('VpcId')) and web_ingress_only(data['SecurityGroups'][0]))
        if subnet and group:
            checks[role + '_network_matches'] = 'pass' if subnet['Subnets'][0].get('VpcId') == group['SecurityGroups'][0].get('VpcId') else 'fail'
        if subnet:
            tables = check(role + '_subnet_route_lookup', profile, 'ec2', 'describe-route-tables',
                           {'Filters': [{'Name': 'association.subnet-id', 'Values': [values['subnet_id']]}]}, lambda _: True)
            if tables is not None and not tables.get('RouteTables'):
                tables = check(role + '_main_route_lookup', profile, 'ec2', 'describe-route-tables',
                               {'Filters': [{'Name': 'vpc-id', 'Values': [subnet['Subnets'][0]['VpcId']]}, {'Name': 'association.main', 'Values': ['true']}]}, lambda _: True)
            if tables is not None:
                checks[role + '_ipv4_default_igw_route'] = 'pass' if any(route.get('DestinationCidrBlock') == '0.0.0.0/0' and str(route.get('GatewayId', '')).startswith('igw-') and route.get('State') == 'active'
                    for table in tables.get('RouteTables', []) for route in table.get('Routes', [])) else 'fail'
        check(role + '_instance_profile_present', profile, 'iam', 'get-instance-profile', {'InstanceProfileName': values['instance_profile_name']},
              lambda data: len(data.get('InstanceProfile', {}).get('Roles', [])) == 1)
        if role == 'pepper':
            check('pepper_key_metadata_matches', profile, 'kms', 'describe-key', {'KeyId': values['pepper_key_id']},
                  lambda data: data.get('KeyMetadata', {}).get('KeySpec') == 'HMAC_256'
                  and data['KeyMetadata'].get('KeyUsage') == 'GENERATE_VERIFY_MAC'
                  and data['KeyMetadata'].get('Origin') == 'AWS_KMS'
                  and data['KeyMetadata'].get('KeyManager') == 'CUSTOMER'
                  and data['KeyMetadata'].get('KeyState') == 'Enabled')
        else:
            bucket = {'Bucket': values['backup_bucket'], 'ExpectedBucketOwner': values['expected_account']}
            check('backup_bucket_region_matches', profile, 's3api', 'head-bucket', bucket,
                  lambda data: data.get('BucketRegion') == REGION)
            check('backup_bucket_public_access_block', profile, 's3api', 'get-public-access-block', bucket,
                  lambda data: all(data.get('PublicAccessBlockConfiguration', {}).get(key) is True for key in ['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets']))
            check('backup_bucket_encryption_present', profile, 's3api', 'get-bucket-encryption', bucket,
                  lambda data: any(rule.get('ApplyServerSideEncryptionByDefault', {}).get('SSEAlgorithm') in {'AES256', 'aws:kms', 'aws:kms:dsse'} for rule in data.get('ServerSideEncryptionConfiguration', {}).get('Rules', [])))
    checks['two_distinct_accounts'] = 'pass' if len(accounts) == 2 and len(set(accounts.values())) == 2 else 'fail'
    return {'mode': 'read_only_observation', 'region': REGION, 'checks': checks,
            'all_observed_checks_passed': all(value == 'pass' for value in checks.values()),
            'deployment_approved': False,
            'not_validated': ['effective_iam_scp_key_policy', 'host_imds_isolation', 'kms_mac_access',
                              's3_backup_restore_permissions', 'image_patch_trust', 'quota_capacity',
                              'tls_dns_google_callback', 'monitor_delivery', 'funding_signer_review']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--private-input', required=True)
    options = parser.parse_args()
    try:
        report = inspect(load_private(options.private_input), Aws())
        print(json.dumps(report, sort_keys=True))
        return 0 if report['all_observed_checks_passed'] else 1
    except Exception:
        print('{"error":"READINESS_INPUT_OR_READ_FAILED","deployment_approved":false}')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
