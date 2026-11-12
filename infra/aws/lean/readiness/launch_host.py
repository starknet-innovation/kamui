#!/usr/bin/env python3
"""Operator-only launch from selected private inputs; never invents resource selections.

Review the exact input and AWS/security plan first. The acknowledgement is an
operator attestation, not evidence of an independent review or an IAM audit.
"""
import argparse
import importlib.util
from pathlib import Path
import re
import inspect_aws

SPEC = importlib.util.spec_from_file_location('kamui_provision', Path(__file__).resolve().parents[1]/'scripts/provision.py')
provision = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(provision)


def prepare(config, role, directory, client):
    report = inspect_aws.inspect(config, client)
    if not report['all_observed_checks_passed']:
        raise ValueError('AWS_INPUT_OBSERVATIONS_NOT_PASSED')
    values = config[role]
    image = client.request(values['aws_profile'], 'ec2', 'describe-images', {'ImageIds': [values['ami_id']]})
    images = image.get('Images', [])
    if len(images) != 1 or images[0].get('ImageId') != values['ami_id'] or images[0].get('OwnerId') != values['approved_ami_owner']:
        raise ValueError('REVIEWED_IMAGE_CHANGED')
    device = images[0].get('RootDeviceName', '')
    result = {'KAMUI_INFRA_REVIEWED': 'yes', 'KAMUI_ROLE': role, 'AWS_PROFILE': values['aws_profile'],
              'EXPECTED_ACCOUNT': values['expected_account'], 'AMI_ID': values['ami_id'],
              'SUBNET_ID': values['subnet_id'], 'SECURITY_GROUP_ID': values['security_group_id'],
              'INSTANCE_PROFILE_NAME': values['instance_profile_name'], 'ROOT_DEVICE_NAME': device,
              'OPERATOR_PRIVATE_DIRECTORY': directory}
    provision.validate(result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--private-input', required=True)
    parser.add_argument('--role', choices=['backend', 'pepper'], required=True)
    parser.add_argument('--private-output-directory', required=True)
    parser.add_argument('--acknowledge-reviewed-plan', action='store_true')
    args = parser.parse_args()
    if not args.acknowledge_reviewed_plan: raise ValueError('INFRA_REVIEW_REQUIRED')
    config = inspect_aws.load_private(args.private_input)
    prepared = prepare(config, args.role, args.private_output_directory, inspect_aws.Aws())
    provision.run(prepared)


if __name__ == '__main__':
    try: main()
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch('[A-Z_]{3,80}', str(error)) else 'HOST_LAUNCH_STOPPED_KEEP_PRIVATE_OUTPUTS'
        print(code); raise SystemExit(1)
