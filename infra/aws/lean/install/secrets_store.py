"""Store each host's runtime files in its Secrets Manager secret. Operator-run (script 13).

Reads the private files script 08 prepared, bundles each host's set with a SHA-256 per file, and
writes the bundle as a new secret version. Nothing here ever reads a secret value back: the result
is confirmed through version metadata only. The relayer key is not handled at all; the operator puts
it into its own secret by hand.
"""
import importlib.util
import json
from pathlib import Path

from common import HERE, private_dir, read_private, sha, write_private

ROLES = ('backend', 'pepper')
SCHEMA = 'kamui.runtime-bundle.v1'


def runtime_module():
    spec = importlib.util.spec_from_file_location('kamui_secrets_runtime', HERE/'runtime.py')
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


def bundle(root, role, runtime=None):
    """The exact files the host expects, as text with their hashes. Owners and modes are the host's."""
    runtime = runtime or runtime_module()
    directory = Path(root)/'installation/runtime'/role
    files = {}
    for relative in sorted(runtime.MANAGED_FILES[role]):
        data = runtime.read(directory/relative)
        try: text = data.decode('utf-8')
        except UnicodeDecodeError: raise ValueError('RUNTIME_FILE_NOT_TEXT') from None
        files[relative] = {'content': text, 'sha256': sha(data)}
    return {'schema': SCHEMA, 'role': role, 'files': files}


def store(root, aws, config, runtime=None):
    runtime = runtime or runtime_module()
    root = Path(root)
    # The same checks script 08 ends with: every file present and unchanged since it was prepared.
    runtime.validate(root)
    records = private_dir(private_dir(root/'installation')/'secrets')
    report = {}
    for role in ROLES:
        result = json.loads(read_private(root/'resources-setup'/(role+'-identity-secrets-result.json')))
        arn = result['RuntimeSecretArn']
        profile = config[role]['aws_profile']
        text = json.dumps(bundle(root, role, runtime), sort_keys=True, separators=(',', ':'))
        digest = sha(text.encode())
        # Same bundle, same token: Secrets Manager treats a resend as the same version.
        token = 'kamui-runtime-'+digest[:40]
        record = {'secretArn': arn, 'bundleSha256': digest, 'versionId': token}
        path = records/(role+'-'+digest[:16]+'.json')
        if path.exists():
            if json.loads(read_private(path)) != record: raise ValueError('SECRET_STORE_RECORD_CHANGED')
        else:
            print('STORING_'+role.upper()+'_RUNTIME_SECRET', flush=True)
            answer = aws.put_secret_value(profile, arn, text, token)
            if answer.get('VersionId') != token or answer.get('ARN') != arn: raise ValueError('SECRET_STORE_RESPONSE_MISMATCH')
        stages = aws.request(profile, 'secretsmanager', 'describe-secret', {'SecretId': arn}).get('VersionIdsToStages', {})
        if 'AWSCURRENT' not in stages.get(token, []): raise ValueError('SECRET_STORED_VERSION_NOT_CURRENT')
        if not path.exists(): write_private(path, record)
        report[role] = {'runtimeVersion': token, 'bundleSha256': digest}
    # The relayer key's value is never read here. CloudFormation created the secret with a single
    # placeholder version; once the operator stores the key there are at least two.
    relayer = result_of(root, 'backend').get('RelayerSecretArn')
    versions = aws.request(config['backend']['aws_profile'], 'secretsmanager', 'describe-secret',
                           {'SecretId': relayer}).get('VersionIdsToStages', {})
    report['relayerKey'] = 'stored' if len(versions) > 1 else 'placeholder_put_the_key_in_by_hand'
    return {'status': 'runtime_secrets_stored', **report, 'secretValuesReadBack': False}


def result_of(root, role):
    return json.loads(read_private(Path(root)/'resources-setup'/(role+'-identity-secrets-result.json')))
