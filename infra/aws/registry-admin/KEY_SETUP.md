# Create the dedicated k1 key — operator steps

**Prepared, not executed.** The user confirmed on 12 November 2026 that the key has not been created. The key and AWS security changes must be made by the user. The approved Sepolia test allowance is separately **four paid attempts, 12 test STRK aggregate, 5 per attempt, no automatic retries**. It does not approve a later registry handoff or hosted deployment. Creating a KMS key also starts AWS charges; the $100/month hosting figure is a planning budget, not an enforced cap.

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

Set these paths and your approved existing key-administrator AWS profile locally. They are paths/names, never credentials. The directory should live on encrypted local storage outside Git. The following creates local files only:

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
