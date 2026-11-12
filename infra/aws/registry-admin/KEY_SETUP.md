# Create the dedicated k1 key — operator steps

**Live-tested with the user’s explicit authorization on 12 November 2026.** The scripts created three roles/profiles and one enabled native k1 key in the existing Kamui backend test account. The user’s later permission to run these setup scripts superseded the earlier operator-only restriction for this test. Future AWS changes remain scoped to explicit authorization. See [sanitized live results](SETUP_VALIDATION-2026-11-12.json). The approved Sepolia test allowance is separately **four paid attempts, 12 test STRK aggregate, 5 per attempt, no automatic retries**. It does not approve a later registry handoff or hosted deployment. Creating a KMS key also starts AWS charges; the $100/month hosting figure is a planning budget, not an enforced cap.

## Start here — create roles, profiles, then the key

You now need **one existing AWS operator administrator profile**, rather than three pre-created roles/profiles. It must belong to the approved test account and already permit IAM role creation/tagging/policy management/readback and assuming the three new roles. Active SSO/federated role sessions are preferred. An existing IAM-user bootstrap profile also works; root identities and AWS-service roles are refused. No new AWS account, IAM user, access key or credential is created. Python 3.9+ and AWS CLI v2 are required.

Run this from the repository for the complete ordered sequence; it stops on the first failure:

```sh
./infra/aws/registry-admin/00-setup-registry-k1.sh
```

Or run the three steps individually, stopping if any step reports failure:

```sh
./infra/aws/registry-admin/01-create-registry-roles.sh
./infra/aws/registry-admin/02-create-registry-profiles.sh
./infra/aws/registry-admin/03-create-registry-k1-key.sh
```

Choose the existing bootstrap profile by number **once**. Step 1 privately resolves its stable IAM principal, prepares `roles-plan.json` and asks for `CREATE ROLES <fingerprint>`. Step 2 preserves your current AWS config and asks for `ADD PROFILES <fingerprint>`. Step 3 automatically uses the newly created profiles, prepares the key policy, and asks for `CREATE <fingerprint>`. No manual ARN editing or AWS-key entry is required.

| Step | Result |
|---|---|
| `01` | Creates `KamuiSepoliaRegistryAdmin`, `KamuiSepoliaRegistryRecovery`, `KamuiSepoliaRegistrySigner` under `/kamui/sepolia/registry/`, with one-hour sessions and trust pinned to the selected bootstrap principal. |
| `02` | Adds `kamui-registry-admin-sepolia`, `kamui-registry-recovery-sepolia`, `kamui-registry-signer-sepolia` as source-profile role chains and verifies they can be assumed. Existing config bytes/comments are preserved; a private backup is retained. |
| `03` | Creates one dedicated AWS-generated k1 key and saves `admin-public-key.json` using the signing profile, reusing the guarded key-creation implementation below. |

All three roles initially trust the **same bootstrap identity**. This separates role sessions and permissions; it **does not provide independent recovery** if that identity/account is lost or compromised. The script does not add an MFA condition or change authentication for the existing bootstrap identity. Use the organization's reviewed operator authentication and review independent recovery before granting contract authority. AWS services are not trust principals, no instance profile is created and no host role is modified; effective off-server isolation still needs review.

The administrator role receives `iam:GetRole` scoped to exactly these three roles, plus `kms:CreateKey` constrained to AWS-generated, Single-Region, secp256k1 signing keys in Ireland with the policy-lockout safety check enabled. `Resource: "*"` is required for this new-key creation permission; it is constrained by those conditions, and is not permission to operate on every existing key. IAM cannot enforce a one-key count: the script's durable intent enforces one creation attempt in this setup directory. Recovery/signing roles receive no inline or managed policy; their eventual operations are granted by the **specific new key's resource policy**. This is distinct from attaching the generated runtime identity-policy baseline below. [KMS key creation](https://docs.aws.amazon.com/kms/latest/APIReference/API_CreateKey.html), [KMS conditions](https://docs.aws.amazon.com/kms/latest/developerguide/conditions-kms.html), [CLI role profiles and source permissions](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-role.html)

The selected bootstrap profile needs its own existing `sts:AssumeRole` authorization, in addition to the new roles' trust. The scripts do not broaden or attach policies to your existing bootstrap identity. Organization-required boundaries, source identities, MFA conditions, or other controls may need a reviewed adaptation; the scripts fail rather than bypass them. The current trust/permissions design must be reviewed by the user acting as AWS/security owner before the numbered creation confirmation.

Configuration and raw AWS responses remain under `~/.kamui-admin-sepolia`, with private permissions. Local AWS profiles go into `AWS_CONFIG_FILE` if set, otherwise `~/.aws/config`; the chosen path is pinned during preparation. That file is updated atomically with mode `0600`. Existing dedicated-profile names, foreign roles, symlinks, policy drift and stale local locks are refused. A private backup can contain existing configuration values: never paste it or raw diagnostics into chat.

Reruns reconcile only roles bearing this setup's exact ownership tags, path, trust and permissions. They do not overwrite a foreign role, change an existing trust policy, attach a broad managed policy, or automatically resend an uncertain mutation. After an ambiguous IAM creation, a later read must prove that exact owned role exists before continuing. Missing/changed ownership or a still-unresolved mutation stops the sequence. IAM propagation can delay readback/assumption: retain the directory and rerun the affected step after checking privately. No role/key deletion, rollback, force or reset is provided.

Use the same directory for all steps and reruns. `--directory /absolute/private/path` is supported for initial preparation; it is not a way to retry an uncertain key creation. If earlier key preparation/creation artifacts exist without a matching roles plan, step 1 stops for reconciliation instead of silently creating a different set of controllers. Local profile updates use a lock and compare the old file immediately before replacement, but unrelated editors do not honor that lock; avoid concurrent config edits.

When complete, give the agent only the absolute path to `admin-public-key.json` and profile name `kamui-registry-signer-sepolia`. No KMS signing, contract deployment or role handoff is performed by these setup scripts.

Local verification: **39 Python tests** using fake AWS account calls and a local, unsigned CLI JSON-parsing check, including the full three-step workflow and repeat, cancellation, partial/uncertain role creation, policy drift, profile conflicts and key-creation safeguards. Shell syntax/help checks pass. Live verification subsequently created and read back all three roles, assumed all three profiles, created the key and checked its actual key policy/public metadata. The full numbered sequence was rerun successfully with the same retained key and one locally recorded creation request. This does not prove independent recovery, native signing interoperability or Starknet acceptance.

## Standalone key wizard — if you already have three role profiles

Requires Python 3.9+, AWS CLI v2, and **three existing role profiles in the same approved account**: administrator, recovery and signing. The administrator profile needs its existing `kms:CreateKey` permission and read-only `iam:GetRole` access for those roles. The other profiles do not need IAM read access. Use reviewed, active temporary AWS sessions; IAM-user/root profiles, duplicate roles, cross-account selections and roles directly trusted by AWS services are refused. This script does not create roles or configure profile trust/credentials.

From the repository, run:

```sh
./infra/aws/registry-admin/setup-k1-key.sh
```

Select each profile by number. The wizard resolves the existing full role references privately, prepares the exact key policy, shows a permission summary and fingerprint, and asks you to type `CREATE <fingerprint-prefix>` after reviewing it. All identifiers, AWS responses and errors stay under `~/.kamui-admin-sepolia` (directory `0700`, files `0600`); no ARN editing, private-key input or manual JSON assembly is needed. Review the private `key-policy.json` and the custody choices below before confirming. The policy administrators can grant themselves signing access by changing that policy. Three distinct roles do not establish independent recovery or effective separation from the hosted services; those remain security-review obligations.

The wizard uses the selected profiles explicitly, disables environment/container/instance credentials as fallbacks, ignores custom configured service endpoints and disables SDK mutation retries. Explicitly allowlisted safe reads retry up to three times on process/socket timeouts; creation and policy writes are never automatically retried. Profiles relying on environment credentials or instance metadata are unsupported. Profile authentication/credential helpers remain part of the trusted local AWS setup. [AWS endpoint and retry settings](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-envvars.html)

It makes one KMS creation attempt, with AWS-generated `ECC_SECG_P256K1` / `SIGN_VERIFY`, Single-Region Ireland, the reviewed policy and the lockout safety check enabled. It then saves `admin-key.json` and uses the signing profile to save and validate `admin-public-key.json`. It does **not** call `kms:Sign` or submit a contract transaction. Once successful, tell the agent only the absolute path to `admin-public-key.json` and the signing profile name.

You can split preparation, creation and export into separate commands:

```sh
./infra/aws/registry-admin/setup-k1-key.sh prepare
./infra/aws/registry-admin/setup-k1-key.sh create
./infra/aws/registry-admin/setup-k1-key.sh export-public
./infra/aws/registry-admin/setup-k1-key.sh status
```

`prepare` performs only profile/identity/role reads and private local writes. `status` is local-only and noninteractive. Other commands require an interactive terminal. `--directory /absolute/private/path` selects another private directory **before initial preparation**; it must be outside the repository and must not be a symlink. Existing files are never overwritten.

A normal rerun reuses the existing key and resumes only an unfinished public-key export. If the creation call fails, times out, or the process stops after persisting its intent, the script refuses another creation attempt. Preserve the original directory and inspect its private diagnostics and AWS console; the unique description in `creation-attempt.json` helps locate an uncertain key. **Do not choose a new directory to bypass this stop.** There is no reset/force/delete, lockout bypass, automatic cleanup or automatic retry. A missing result file does not establish that AWS created no key.

The key-wizard tests cover the full wizard, repeat execution, changed profiles/policies, private files, cancellation and uncertain creation; an offline CLI parsing regression uses `--generate-cli-skeleton input --no-sign-request` without an account API call. The combined setup suite has 39 tests. Shell syntax/help checks pass. The key wizard also completed its authorized live creation/public-export flow as recorded above. Run its tests without creating bytecode artifacts:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover \
  -s infra/aws/registry-admin -p 'test_setup_k1_key.py'
```

The remaining sections document the policy and lower-level manual equivalent; the wizard performs their file assembly and commands for you.

## 1. Review the concrete custody policy

Use the existing approved AWS account in `eu-west-1`. On the operator workstation, select existing **key-administrator**, **key-recovery** and **operator-signing** roles. Keep their real identifiers in private files. Do not create or change an IAM role just to make this template work without reviewing that change. The creator must be able to retain `kms:PutKeyPolicy` through the policy; do not bypass KMS's policy-lockout safety check.

Copy [key-policy.review-template.json](key-policy.review-template.json) into a private directory outside the repository. Replace its three placeholder principals privately with the reviewed IAM role references. The example intentionally cannot be applied unchanged. The user/security reviewer must review the resulting file before using it. `Resource: "*"` in this **key resource policy** means the key carrying that policy; this is not an identity policy granting all keys. The administrator and recovery roles can change the policy and therefore can grant signing authority to themselves. The signing role receives only public-key access and k1 digest signing through this template. It must not be a backend/pepper EC2 instance role. Existing role trust policies, identity grants, SCPs, permission boundaries and sessions need separate review. This template does not create any role, supply deployment identity permissions, or prove role independence. [AWS key policies](https://docs.aws.amazon.com/kms/latest/developerguide/key-policies.html), [AWS policy administration](https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-default.html), [KMS signing conditions](https://docs.aws.amazon.com/kms/latest/developerguide/conditions-kms.html#conditions-kms-message-type)

The template intentionally omits an account-wide IAM-delegation statement and direct key-disable/deletion grants. Those choices restrict the initial policy but **do not make the key undeletable**: policy administrators can change it. Review how the recovery role remains assumable if the primary role/operator is lost. Neither this recovery role nor a multi-Region replica recovers a deleted private key. An independent on-chain fallback administrator, if desired, is a separate governance choice before old-role renunciation.

For a reproducible **identity-policy baseline** from the runtime code, the installed tool was checked locally (`iam-policy-autopilot 0.4.0`) and generation detected exactly `kms:GetPublicKey` and `kms:Sign`; no policy was uploaded or applied. Run generation locally, inspect its output privately, and pin any eventual signing grant to the exact new key. Do not apply a wildcard baseline:

```sh
umask 077
uvx iam-policy-autopilot@latest generate-policies \
  /Users/adrienlacombe/ws/kamui/infra/aws/registry-admin/signer.ts \
  --region eu-west-1 --service-hints kms \
  --tf-dir /Users/adrienlacombe/ws/kamui/infra/aws/terraform/backend --pretty \
  > "$KAMUI_PRIVATE_DIRECTORY/operator-identity-baseline.json" \
  2> "$KAMUI_PRIVATE_DIRECTORY/operator-identity-baseline.log"
```

The account was deliberately not guessed. On the operator machine you can supply its privately known value with `--account "$KAMUI_EXPECTED_ACCOUNT"`; never print it. The current Terraform does not define the new k1 key, so static analysis cannot resolve its runtime key reference. This generated identity baseline is distinct from the reviewed key resource policy above. No `--upload-policies`, role attachment or Terraform apply is part of these commands.

## 2. Prepare private storage and select the creation profile

Set these paths and your approved existing key-administrator AWS profile locally. They are paths/names, never credentials. The directory should live on encrypted local storage outside Git. The following manual directory/file commands create local files only:

```sh
umask 077
KAMUI_PRIVATE_DIRECTORY="$HOME/.kamui-admin-sepolia"
mkdir -m 700 "$KAMUI_PRIVATE_DIRECTORY"
# If it already exists, inspect its ownership/mode; do not reuse an unknown directory.
# Set AWS_PROFILE to your existing reviewed key-administrator profile locally.
cp /Users/adrienlacombe/ws/kamui/infra/aws/registry-admin/key-policy.review-template.json \
  "$KAMUI_PRIVATE_DIRECTORY/key-policy.json"
chmod 600 "$KAMUI_PRIVATE_DIRECTORY/key-policy.json"
# Edit the three placeholders in this private copy, then review the policy.
```

Use a fresh directory/output name for a new attempt. Do not overwrite previous creation results. If a command fails or times out, preserve its private output and inspect the console/CloudTrail before retrying `create-key`: a key may already exist and duplicate creation incurs cost. Keep all AWS CLI output and errors private. Do not paste them into chat.

Before creation, confirm the selected identity/account privately:

```sh
aws sts get-caller-identity --profile "$AWS_PROFILE" --region eu-west-1 --output json --no-cli-pager \
  > "$KAMUI_PRIVATE_DIRECTORY/creator-identity.json" \
  2> "$KAMUI_PRIVATE_DIRECTORY/creator-identity.log"
```

Compare it privately to the approved account/administrator role. A successful identity read is not a policy or role-trust review. The creation profile needs the preexisting identity permission to create this specific kind of KMS key; this package does not grant it.

## 3. Create exactly one reviewed key

After replacing the placeholders and reviewing the exact policy, run **once**, with no implicit CLI retry. `set -C` prevents accidental shell output-file replacement. Do not add a lockout-bypass flag:

```sh
set -C
AWS_MAX_ATTEMPTS=1 aws kms create-key \
  --key-spec ECC_SECG_P256K1 --key-usage SIGN_VERIFY --origin AWS_KMS \
  --policy "file://$KAMUI_PRIVATE_DIRECTORY/key-policy.json" \
  --description 'Kamui Sepolia manual registry administrator' \
  --region eu-west-1 --profile "$AWS_PROFILE" --output json --no-cli-pager \
  > "$KAMUI_PRIVATE_DIRECTORY/admin-key.json" \
  2> "$KAMUI_PRIVATE_DIRECTORY/admin-key.log"
```

The key is generated by KMS. No private key is entered, imported, exported or installed. The key is separate from both pepper HMAC and the transaction relayer. No alias, automatic rotation, replica, grants or account/role changes are created by this command. Review the console result privately before proceeding.

## 4. Save metadata privately using the signing profile

Extract only the immutable key reference into an AWS CLI input file; the following local Python writes it exclusively and prints nothing:

```sh
python3 - "$KAMUI_PRIVATE_DIRECTORY" <<'PY'
import json, os, pathlib, stat, sys
root = pathlib.Path(sys.argv[1])
info = root.lstat()
if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
    raise SystemExit('PRIVATE_DIRECTORY_REQUIRED')
with (root / 'admin-key.json').open() as handle:
    record = json.load(handle)['KeyMetadata']
if record['KeySpec'] != 'ECC_SECG_P256K1' or record['KeyUsage'] != 'SIGN_VERIFY' or record['Origin'] != 'AWS_KMS':
    raise SystemExit('KMS_KEY_METADATA_MISMATCH')
fd = os.open(root / 'get-public-key-input.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as handle:
    json.dump({'KeyId': record['Arn']}, handle)
    handle.write('\n')
PY
# Select the existing reviewed operator-signing AWS profile locally.
# Do not accidentally reuse the creation profile unless that exact access is reviewed.
AWS_MAX_ATTEMPTS=1 aws kms get-public-key \
  --cli-input-json "file://$KAMUI_PRIVATE_DIRECTORY/get-public-key-input.json" \
  --region eu-west-1 --profile "$AWS_PROFILE" --output json --no-cli-pager \
  > "$KAMUI_PRIVATE_DIRECTORY/admin-public-key.json" \
  2> "$KAMUI_PRIVATE_DIRECTORY/admin-public-key.log"
```

Tell the agent **only the absolute path** to the private `admin-public-key.json` and the chosen profile name. No credentials, key identifiers or AWS outputs belong in chat. The metadata has a public SPKI and immutable key reference; it is not a private signing key. The next step is a bounded real KMS compatibility check, followed by separately reviewed account declaration/deployment and a harmless Sepolia transaction. Never grant registry roles before proving control of the deployed account and completing custody/recovery review.

## Live findings incorporated into the scripts

The live test found three SDK/CLI details not represented by the first fakes: stdin-backed JSON was rejected by the installed CLI, `CreateRole` omitted `MaxSessionDuration` in its reply, and successful `PutRolePolicy` emitted an empty body. Requests now use exclusive private JSON files instead of stdin; roles are verified using a complete `GetRole` read-back; only the known void IAM write accepts an empty successful CLI response. Regression tests cover each case. Persistent intents allowed continuation without recreating the first role or rewriting its already-applied policy.

Live KMS signing, the new Starknet administrator deployment, registry handoff and hosting deployment were not performed. No test STRK was spent by setup. Private AWS identifiers, raw outputs and the local AWS configuration backup remain outside Git; only the sanitized setup result is committed when requested.

## A timeout during an already-completed setup

A later rerun timed out on the signing role's `ListAttachedRolePolicies` read, before any creation request. Its former generic `AWS_REQUEST_UNCERTAIN_PRIVATE_LOGS_RETAINED` message incorrectly made that look like an uncertain key creation. The existing three roles/profiles and enabled key were retained.

The wrapper now shows its current step. Each account request has private operation/attempt metadata, a 5-second connect timeout, a 15-second socket-read timeout and a 45-second process deadline. Safe reads have at most three attempts on timeout, with an `AWS_READ_RETRY service:operation` status. Authentication/permission failures are not retried. An exhausted read reports `AWS_READ_TIMEOUT service:operation`; it does not suggest that a key may have been created. Mutation timeouts still report `AWS_MUTATION_UNCERTAIN` and never retry. Completed role runs now perform verification only, without trying to recreate or repair roles/policies.

Keep using the original setup directory. Do not remove `creation-attempt.json`, policy markers or private evidence to fix a read timeout. The normal command can be rerun after connectivity recovers; local `./setup-k1-key.sh status` reports saved state without contacting AWS.
