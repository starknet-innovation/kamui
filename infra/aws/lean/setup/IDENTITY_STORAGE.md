# Sepolia host identities and private backups

`identity-storage.json` is an operator-run CloudFormation template for each existing test account. It creates a dedicated EC2 role/instance profile and, in the backend account only, a dedicated S3 backup repository. It creates no AWS account or KMS key and never replaces the existing pepper key policy. The ordered runner supplies all real resource values privately. Creating the named IAM role requires `CAPABILITY_NAMED_IAM`.

## Runner contract

| Parameter | Value |
|---|---|
| `HostRole` | `backend` or `pepper` |
| `BackupBucketName` | Unique dedicated bucket name for backend; empty for pepper |
| `ExistingPepperKeyArn` | Existing eu-west-1 HMAC key reference for pepper; empty for backend |

Both roles/profiles have the deterministic name `KamuiSepolia-<role>-Host` under `/kamui/sepolia/hosts/`. Outputs are `InstanceProfileName`, `HostRoleArn` and, for backend only, `BackupBucketName` and `BackupRepositoryPrefix`. Outputs and CloudFormation diagnostics may contain sensitive AWS metadata and must remain in the operator's mode-0700 directory, never shared terminal/chat/Git output.

## Permissions and storage controls

- EC2 is the sole trust principal. Both identities attach AWS's [`AmazonSSMManagedInstanceCore`](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonSSMManagedInstanceCore.html) for the reviewed Session Manager/agent path. Its published baseline includes SSM document and parameter reads, not just interactive session channels. Review that scope and the actual caller/SSM access path; this is not a per-container credential boundary. No extra SSM/Secrets Manager values are created by this package.
- Backend permits bucket location and multipart-upload metadata on its own dedicated bucket, prefix-conditioned object listing, and get/put/delete/abort/list-parts operations only on `kamui-sepolia/*`. The multipart listing is bucket-scoped metadata, not another object-data grant. These actions match the named pgBackRest repository operations; [S3's operation-to-action mappings](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-with-s3-policy-actions.html) distinguish bucket/object permissions. No ACL, object-lock, version, bucket-management or other bucket permission is granted. Backend explicitly denies all KMS actions.
- Pepper allows only `GenerateMac`, `VerifyMac` and `DescribeKey` on the exact existing key. One explicit deny blocks all KMS actions on other resources; a second scoped [`NotAction` deny](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_notaction.html) blocks every operation except those three on the selected key. Thus it cannot use the k1 signing key or change this key's policy under these generated policies.
- Both roles explicitly deny IAM changes and role/session credential chaining. This is a policy baseline, not a complete effective IAM/SCP/resource-policy audit. An operator able to change these policies can change the boundary; the three registry operator roles must never be installed or made assumable from a host.
- The backend bucket has SSE-S3 AES256, all four public-access blocks, bucket-owner-enforced ownership and a TLS-only bucket policy. Bucket and policy are retained on stack deletion/replacement. No seven-day S3 expiration is installed: deleting a base backup or WAL segment independently can invalidate recovery. No S3 versioning/object lock is enabled here; backup deletion remains possible within the host's repository prefix. The selected pgBackRest seven-day proposal remains subject to actual restore/retention/privacy review. A successful stack does not prove backup or restore works.

## Existing pepper key policy

An IAM allow alone is insufficient if the existing key policy does not enable IAM delegation or allow this new role. AWS explains this in [default key policy semantics](https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-default.html). The runner must read the exact existing key policy privately and stop if the required access path is absent or uncertain. It must not silently overwrite that policy, replace the key or interpret a policy-read failure as access approval. An exceptional policy change requires a separately reviewed additive statement for the new `HostRoleArn`, preserving administrators and the existing key; no key-policy writer is included in this template.

Confirm metadata is customer-managed, enabled `HMAC_256` / `GENERATE_VERIFY_MAC` in the selected pepper account/Region. Verify actual MAC use from the approved host identity before enabling the service. Do not test by exporting key material or granting the host a registry signer identity.

## Local validation and scope

```sh
python3 -B -m unittest discover -s infra/aws/lean/setup -p test_identity_storage.py
uvx --from cfn-lint==1.60.1 cfn-lint infra/aws/lean/setup/identity-storage.json
```

Five offline invariant tests and CloudFormation lint pass. A documented template-local W1030 suppression handles its empty key parameter for backend: the linter otherwise treats that unused pepper branch as an invalid ARN. The key's `AllowedPattern` and `PepperKeyRequired` rule still reject an empty key in pepper mode. Other lint rules remain enabled. The template derives permissions from the explicitly requested operations and verifies mappings against AWS's public Service Authorization Reference; it does not claim static application-source analysis or use source-derived permission guesses.

No AWS request or permission change was made while preparing this template. CloudFormation deployment, IAM propagation, Session Manager, live MAC access, S3 repository operations/restore and effective isolation remain operator acceptance checks. The user accepts the current sole-KMS arrangement for Sepolia only; this is not the mainnet custody design or approval.
