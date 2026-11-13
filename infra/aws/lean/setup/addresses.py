#!/usr/bin/env python3
"""Operator EIP stage. Private durable intents; mutations are never retried here.

AllocateAddress has no ClientToken. Reconcile the exact setup tags after an
uncertain request; do not delete state or allocate another address to retry.
"""
import fcntl
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import stat

# The private-file primitives are setup_resources.py's, so every setup stage reads and writes alike.
_SPEC = importlib.util.spec_from_file_location('kamui_addresses_base', Path(__file__).resolve().parent/'setup_resources.py')
_base = importlib.util.module_from_spec(_SPEC); _SPEC.loader.exec_module(_base)
write_private = _base.write_private


def private_directory(path, create=False):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path:
        raise ValueError('PRIVATE_DIRECTORY_REQUIRED')
    if create:
        path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('PRIVATE_DIRECTORY_REQUIRED')
    return path


def read_private(path):
    return json.loads(_base.read_private(path))


def preserve(path, value):
    if path.exists() or path.is_symlink():
        if read_private(path) != value:
            raise ValueError('ADDRESS_SAVED_STATE_CHANGED')
    else:
        write_private(path, value)


def require_id(value, prefix):
    if not isinstance(value, str) or not re.fullmatch(prefix+r'-[0-9a-f]{8,17}', value):
        raise ValueError('ADDRESS_RESOURCE_INVALID')
    return value


def call(aws, profile, service, operation, inputs):
    try:
        return aws.request(profile, service, operation, inputs)
    except Exception:
        raise ValueError('ADDRESS_REQUEST_UNCERTAIN_KEEP_PRIVATE_STATE') from None


def instance(root, role, values, aws):
    launch_directory = private_directory(root/(role+'-launch'))
    saved = read_private(launch_directory/(role+'-instance.json'))
    saved_instances = saved.get('Instances')
    if not isinstance(saved_instances, list) or len(saved_instances) != 1:
        raise ValueError('ADDRESS_EXACT_LAUNCH_REQUIRED')
    identifier = require_id(saved_instances[0].get('InstanceId'), 'i')
    reply = call(aws, values['aws_profile'], 'ec2', 'describe-instances', {'InstanceIds': [identifier]})
    reservations = reply.get('Reservations')
    if not isinstance(reservations, list) or len(reservations) != 1 or reservations[0].get('OwnerId') != values['expected_account']:
        raise ValueError('ADDRESS_INSTANCE_OWNER_MISMATCH')
    instances = reservations[0].get('Instances')
    if not isinstance(instances, list) or len(instances) != 1:
        raise ValueError('ADDRESS_EXACT_INSTANCE_REQUIRED')
    item = instances[0]
    if item.get('InstanceId') != identifier or item.get('SubnetId') != values['subnet_id'] or item.get('State', {}).get('Name') not in {'pending', 'running'}:
        raise ValueError('ADDRESS_INSTANCE_MISMATCH')
    if item.get('ImageId') != values['ami_id']:
        raise ValueError('ADDRESS_INSTANCE_IMAGE_MISMATCH')
    tags = {t.get('Key'): t.get('Value') for t in item.get('Tags', [])}
    if any(tags.get(key) != val for key, val in {'Project': 'kamui', 'Network': 'sepolia', 'Role': role}.items()):
        raise ValueError('ADDRESS_INSTANCE_TAG_MISMATCH')
    groups = item.get('SecurityGroups')
    if not isinstance(groups, list) or len(groups) != 1 or groups[0].get('GroupId') != values['security_group_id']:
        raise ValueError('ADDRESS_INSTANCE_GROUP_MISMATCH')
    enis = item.get('NetworkInterfaces')
    if not isinstance(enis, list) or len(enis) != 1:
        raise ValueError('ADDRESS_SINGLE_INTERFACE_REQUIRED')
    eni = enis[0]
    # DescribeInstances embeds the ENI under the already verified instance; its
    # InstanceNetworkInterfaceAttachment has no InstanceId field (unlike the
    # attachment returned by DescribeNetworkInterfaces).
    if eni.get('SubnetId') != values['subnet_id'] or eni.get('Attachment', {}).get('DeviceIndex') != 0 or eni.get('Attachment', {}).get('Status') != 'attached':
        raise ValueError('ADDRESS_PRIMARY_INTERFACE_REQUIRED')
    if len(eni.get('Groups', [])) != 1 or eni['Groups'][0].get('GroupId') != values['security_group_id']:
        raise ValueError('ADDRESS_INTERFACE_GROUP_MISMATCH')
    require_id(eni.get('NetworkInterfaceId'), 'eni')
    try:
        address = ipaddress.IPv4Address(eni.get('PrivateIpAddress'))
    except Exception:
        raise ValueError('ADDRESS_PRIVATE_IP_INVALID') from None
    if not address.is_private:
        raise ValueError('ADDRESS_PRIVATE_IP_INVALID')
    return {'InstanceId': identifier, 'NetworkInterfaceId': eni['NetworkInterfaceId'], 'PrivateIpAddress': str(address)}


def address_matches(address, target):
    return (address.get('InstanceId') == target['InstanceId']
            and address.get('NetworkInterfaceId') == target['NetworkInterfaceId']
            and address.get('PrivateIpAddress') == target['PrivateIpAddress']
            and bool(re.fullmatch(r'eipassoc-[0-9a-f]{8,17}', address.get('AssociationId', ''))))


def validate_address(address, tags):
    require_id(address.get('AllocationId'), 'eipalloc')
    try:
        public = ipaddress.IPv4Address(address.get('PublicIp'))
    except Exception:
        raise ValueError('ADDRESS_PUBLIC_IP_INVALID') from None
    if not public.is_global or address.get('Domain') != 'vpc':
        raise ValueError('ADDRESS_PUBLIC_IP_INVALID')
    actual = {tag.get('Key'): tag.get('Value') for tag in address.get('Tags', [])}
    if any(actual.get(key) != val for key, val in tags.items()):
        raise ValueError('ADDRESS_SETUP_TAG_MISMATCH')
    return address


def assign_role(directory, role, values, target, run_id, aws):
    profile = values['aws_profile']
    tags = {'Project': 'kamui', 'Network': 'sepolia', 'SetupRun': run_id, 'Role': role}
    query = {'Filters': [{'Name': 'tag:'+key, 'Values': [value]} for key, value in tags.items()]}
    # An existing EIP on the target must never be displaced, even if the new EIP
    # itself is unassigned and AllowReassociation=False would permit replacement.
    target_addresses = call(aws, profile, 'ec2', 'describe-addresses', {'Filters': [{'Name': 'instance-id', 'Values': [target['InstanceId']]}]}).get('Addresses')
    if not isinstance(target_addresses, list) or len(target_addresses) > 1:
        raise ValueError('ADDRESS_TARGET_AMBIGUOUS')
    for current in target_addresses:
        validate_address(current, tags)
        if not address_matches(current, target):
            raise ValueError('ADDRESS_TARGET_ALREADY_HAS_OTHER_ADDRESS')
    matches = call(aws, profile, 'ec2', 'describe-addresses', query).get('Addresses')
    if not isinstance(matches, list) or len(matches) > 1:
        raise ValueError('ADDRESS_ALLOCATION_AMBIGUOUS')
    allocate_request = {'Domain': 'vpc', 'TagSpecifications': [{'ResourceType': 'elastic-ip', 'Tags': [{'Key': key, 'Value': value} for key, value in tags.items()]}]}
    intent = directory/(role+'-allocate-intent.json')
    if intent.exists() or intent.is_symlink():
        if read_private(intent) != allocate_request:
            raise ValueError('ADDRESS_SAVED_STATE_CHANGED')
    if not matches:
        if intent.exists():
            raise ValueError('ADDRESS_ALLOCATION_UNCERTAIN_RECONCILE_ONLY')
        if target_addresses:
            raise ValueError('ADDRESS_ALLOCATION_OBSERVATION_CONFLICT')
        write_private(intent, allocate_request)
        result = call(aws, profile, 'ec2', 'allocate-address', allocate_request)
        write_private(directory/(role+'-allocate-response.json'), result)
        allocation_id = require_id(result.get('AllocationId'), 'eipalloc')
        matches = call(aws, profile, 'ec2', 'describe-addresses', {'AllocationIds': [allocation_id]}).get('Addresses')
        if not isinstance(matches, list) or len(matches) != 1 or matches[0].get('AllocationId') != allocation_id:
            raise ValueError('ADDRESS_ALLOCATION_PENDING_RECONCILE_ONLY')
    address = validate_address(matches[0], tags)
    response_path = directory/(role+'-allocate-response.json')
    if response_path.exists() or response_path.is_symlink():
        saved = read_private(response_path)
        if saved.get('AllocationId') != address['AllocationId'] or saved.get('PublicIp') != address['PublicIp']:
            raise ValueError('ADDRESS_ALLOCATION_CHANGED')
    binding = {'AllocationId': address['AllocationId'], 'PublicIp': address['PublicIp'], **target}
    preserve(directory/(role+'-allocation.json'), binding)
    associate_request = {'AllocationId': address['AllocationId'], 'NetworkInterfaceId': target['NetworkInterfaceId'], 'PrivateIpAddress': target['PrivateIpAddress'], 'AllowReassociation': False}
    associate_intent = directory/(role+'-associate-intent.json')
    if associate_intent.exists() or associate_intent.is_symlink():
        if read_private(associate_intent) != associate_request:
            raise ValueError('ADDRESS_SAVED_STATE_CHANGED')
    if not address_matches(address, target):
        if any(address.get(key) for key in ['AssociationId', 'InstanceId', 'NetworkInterfaceId']):
            raise ValueError('ADDRESS_ALREADY_ASSOCIATED_ELSEWHERE')
        if associate_intent.exists():
            raise ValueError('ADDRESS_ASSOCIATION_UNCERTAIN_RECONCILE_ONLY')
        # Recheck the destination immediately before recording/submitting this
        # mutation. No helper can remove the residual external concurrent-writer race.
        attached = call(aws, profile, 'ec2', 'describe-addresses', {'Filters': [{'Name': 'instance-id', 'Values': [target['InstanceId']]}]}).get('Addresses')
        if attached != []:
            raise ValueError('ADDRESS_TARGET_ALREADY_HAS_OTHER_ADDRESS')
        write_private(associate_intent, associate_request)
        result = call(aws, profile, 'ec2', 'associate-address', associate_request)
        write_private(directory/(role+'-associate-response.json'), result)
        observed = call(aws, profile, 'ec2', 'describe-addresses', {'AllocationIds': [address['AllocationId']]}).get('Addresses')
        if not isinstance(observed, list) or len(observed) != 1 or observed[0].get('AllocationId') != address['AllocationId']:
            raise ValueError('ADDRESS_ASSOCIATION_PENDING_RECONCILE_ONLY')
        address = validate_address(observed[0], tags)
        if not address_matches(address, target):
            raise ValueError('ADDRESS_ASSOCIATION_PENDING_RECONCILE_ONLY')
    preserve(directory/(role+'-verified.json'), {**binding, 'AssociationId': address['AssociationId'], 'SetupRun': run_id, 'Role': role})


def assign(root, config, aws):
    root = private_directory(root)
    state = private_directory(root/'resources-setup')
    plan = read_private(state/'plan.json')
    run_id = plan.get('runId')
    if not isinstance(run_id, str) or not re.fullmatch(r'[a-f0-9]{32}', run_id):
        raise ValueError('ADDRESS_SETUP_RUN_INVALID')
    if config.get('version') != 1 or config.get('region') != 'eu-west-1':
        raise ValueError('ADDRESS_SEPOLIA_INPUT_REQUIRED')
    if config['backend']['expected_account'] == config['pepper']['expected_account']:
        raise ValueError('ADDRESS_DISTINCT_ACCOUNTS_REQUIRED')
    # Both identities precede either account's resource reads and all mutations.
    for role in ['backend', 'pepper']:
        values = config[role]
        if not re.fullmatch(r'\d{12}', values.get('expected_account', '')) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', values.get('aws_profile', '')):
            raise ValueError('ADDRESS_IDENTITY_INPUT_INVALID')
        reply = call(aws, values['aws_profile'], 'sts', 'get-caller-identity', {})
        if reply.get('Account') != values['expected_account']:
            raise ValueError('ADDRESS_ACCOUNT_MISMATCH')
    directory = private_directory(state/'addresses', create=True)
    lock = os.open(directory/'.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or info.st_mode & 0o077:
            raise ValueError('PRIVATE_FILE_REQUIRED')
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise ValueError('ADDRESS_SETUP_BUSY') from None
        targets = {role: instance(root, role, config[role], aws) for role in ['backend', 'pepper']}
        for role in ['backend', 'pepper']:
            assign_role(directory, role, config[role], targets[role], run_id, aws)
    finally:
        os.close(lock)
    return {'status': 'addresses_verified', 'roles': ['backend', 'pepper'], 'awsIdentifiersPrinted': False}
