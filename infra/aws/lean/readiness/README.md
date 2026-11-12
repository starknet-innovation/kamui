# Operator readiness and deployment sequence

Prepared 12 November 2026 for the selected lean Google-only Sepolia beta. The $100/month AWS **planning** budget and separate registry administrator direction are selected; off-server/manual custody is selected and the User is the AWS operator/security reviewer; technical approval evidence remains pending in [REVIEW_DECISIONS.md](REVIEW_DECISIONS.md). No AWS account/resource/security settings, DNS, Google configuration, image publication or signing authority was changed by this preparation. The registry ABI/role-admin observation below used read-only public Sepolia RPC.

This is the concrete review package for an authorized operator. The agent does not create cloud accounts or change AWS security settings. A passed helper is not an IAM audit, deployment authorization, fee cap or security sign-off.

## Current execution packages

The user requested registry handoff preparation, hosting review and hosted-beta execution in parallel. Start with the [exact handoff review](HANDOFF_REVIEW-2026-11-12.md), [ordered AWS/host commands](HOSTING_EXECUTION-2026-11-12.md) and [hosted acceptance runner](BETA_ACCEPTANCE-2026-11-12.md). These packages record actual observations separately from pending operator actions. AWS provisioning/security changes remain user-run; no reviewed resource selection or custody approval is guessed. The KMS account is deployed and tested, while registry roles remain with the relayer and the hosted origins are unavailable.

## 1. Complete the named review record

Copy `review.example.json` to a private operator directory outside Git. The template records the selected `separate_offserver_manual_rotation` mode, $100 planning budget and User operator/security roles. The custody selector is `kms_secp256k1_manual_operator`; seven-day backup/log retention is recorded as selected, subject to privacy review. Fill private technical evidence; no accepted flags are supplied. The lean backend now has no automatic hot rotator or administrator-key source. Changing to a hot registry administrator would need a revised reviewed package and custody decision, not merely editing this record. Run from the repository root:

```sh
python3 infra/aws/lean/readiness/review.py --record /private/kamui/review.json
```

The checker prints fixed missing-field labels only. It does not print reviewer names/references or authenticate signatures/approve the design. The committed example intentionally fails until those decisions exist. Do not turn `accepted` flags on merely to make a command green.

Required reviews cover the actual AWS/network/key permissions, shared host-role/IMDS exposure, admin upgrade authority, dedicated KMS key/operator signing policy with no effective hosted `kms:Sign` permission, immutable k1 admin contract/live-control evidence and independent recovery/governance, public abuse/egress, exact funding policies/apps, AVNU external controls or local transport, backup repository/retention/restore, real alert delivery and Google/DNS ownership. Public app identifiers and Origin headers are not sponsor credentials.

## 2. Inspect existing AWS resources without printing their identifiers

The AWS owner selects existing resources privately. Copy `private-input.example.json` outside Git, fill both expected account IDs, reviewed AMI publisher IDs, resource references and the explicit existing pepper **key ARN**; keep mode `0600`. No private keys, secret values or AWS access keys belong in it. Do not paste it into chat. The inspector refuses a wrong profile/account before inspecting that account's resources; aliases are refused for KMS because DescribeKey on some predefined AWS-managed aliases has creation behavior.

With AWS CLI v2 already authenticated through the organization's existing process, the operator may run:

```sh
python3 infra/aws/lean/readiness/inspect_aws.py --private-input /private/kamui/aws-input.json > /private/kamui/aws-observations.json
```

The subprocess captures all raw AWS JSON/errors in memory and prints only fixed check labels/statuses. Resource selectors use mode-0600 regular JSON request files in a private temporary directory, rather than shell interpolation or command arguments. Its explicit operation allowlist includes only STS identity, EC2 image/network reads, IAM profile lookup, the explicit existing KMS key metadata, and S3 bucket metadata. It never retrieves secret values, performs MACs, uploads objects, creates resources or edits permissions. Run in a reviewed AWS CLI environment; it does not secure a compromised workstation/profile.

Observed checks cover expected/distinct accounts, available x86/EBS AMI from the approved publisher, subnet/SG VPC consistency, exact web-only ingress shape, active IPv4 default IGW route, one role in the chosen instance profile, expected enabled HMAC key metadata and bucket Region/public-access-block/encryption configuration. A present profile does **not** establish its effective permissions. IAM/SCP/key policy, container metadata isolation, actual KMS MAC and S3 backup access, quota/capacity, image patch trust, monitoring and public ingress remain owner checks. S3 metadata checks are not a bucket-policy audit or encryption/restore guarantee.

All observations must be current for the private account-aware review. A nonzero exit means unavailable or mismatched observations; no helper tries to fix them. No actual AWS inventory result has been collected by this work. Primary references: [EC2 images](https://docs.aws.amazon.com/cli/latest/reference/ec2/describe-images.html), [security groups](https://docs.aws.amazon.com/cli/latest/reference/ec2/describe-security-groups.html), [DescribeKey limitations](https://docs.aws.amazon.com/cli/latest/reference/kms/describe-key.html), [HeadBucket](https://docs.aws.amazon.com/cli/latest/reference/s3api/head-bucket.html).

## 3. Prepare the registry-role handoff, then let its owner sign

The deployed registry uses AccessControl, **not `transfer_ownership`**. `DEFAULT_ADMIN_ROLE` is `0`; `REVOKER_ROLE` is the selector of `REVOKER_ROLE`. The initial registry account has both. The admin role authorizes JWK additions/replacements **and upgrades**; the revoker role authorizes removals. Review the custody/upgrade consequence before preparing a handoff. [Local source](../../../../contracts/src/jwt/registry.cairo), [OpenZeppelin access control](https://docs.openzeppelin.com/contracts-cairo/api/access)

Keep the API, rotator and automatic supervisors stopped through the actual handoff. Confirm the old process exited and no independent nonce writer can restart. The new administrator must already be deployed and separately controlled under the reviewed custody process. The user selected a dedicated [AWS KMS secp256k1 admin account](../../registry-admin/README.md), manually operated from the workstation; its real KMS signing, deployment and harmless Ping passed in [run 13](../../../../spikes/s1/results/run-13-kms-admin.md); account/custody review and registry role handoff remain pending. It is not an air-gapped key. The user selected sole-KMS administration and explicitly accepted loss-of-key risk on 12 November 2026. Effective permissions/custody and the exact authority changes still require review; no independent fallback is being prepared. Do not use a Kamui/social account whose recovery depends on this registry: registry recovery authority must not be circular. The helper neither creates it nor accepts a private key.

First obtain a fresh public observation (private output directory must be absolute, owned by the caller and mode `0700`):

```sh
python3 infra/aws/lean/readiness/registry_handoff.py observe \
  --registry 0x4bc2b2afcce053e788511a851e6aeb004d18adb243df4fe852e1b727bd09808 \
  --private-output-directory /private/kamui/handoff-observation
```

The committed [observation](public-registry-observation.json) already confirms the current access-control ABI and that both role administrators are the default admin. It does not approve custody, attest the class's implementation or replace a fresh check before signing.

Copy `handoff-input.example.json` privately with mode `0600`. Fill only public contract/account addresses, the **reviewed registry class hash**, `expectedNewAdministratorClassHash` for the separately reviewed `KmsK1Admin` build, and `expectedNewAdministratorPublicKey` as the full uncompressed SEC1 `0x04` + x + y public key. Compare the public key independently with the reviewed KMS public key. These values are not inferred from whichever account happens to be deployed. Use no signing-key values or AWS identifiers.

The helper refuses a changed new-account class, invalid/off-curve public key, unexpected public-key ABI/limbs, or any mismatch with the deployed full key. Registry, roles and controller class/key reads are anchored to the accepted head's block hash. This is a trusted-RPC observation; class-pin review must establish the account is the intended immutable implementation, and public matching does not prove KMS policy or custody. `controllerProofTransactionHash` can remain empty for the initial unsigned grant preparation, but must be filled before renunciation or final verification. Then:

```sh
python3 infra/aws/lean/readiness/registry_handoff.py prepare-grant \
  --private-input /private/kamui/handoff-input.json \
  --private-output-directory /private/kamui/handoff-grant
```

This writes an unsigned `calls` array: `grant_role(DEFAULT_ADMIN_ROLE, newAccount)` and `grant_role(REVOKER_ROLE, newAccount)`, to execute from the old administrator account. The authorized owner reviews and signs that exact batch in its normal approved wallet. Do not copy any signer key into the helper, CLI, browser form or chat. Wait for accepted successful execution; independently confirm the new account's controller can operate its approved wallet. Granting roles alone does not prove control. Before either authority-changing handoff transaction, obtain explicit approval of the exact batch after custody/recovery review. The user has removed Sepolia STRK spending caps; no further fee permission is needed. That spending authorization does not itself approve registry role changes. Do not broadcast the role batches from this read-only helper.

Record `controllerProofTransactionHash` from the completed harmless live test: an accepted, successful, non-query V3 INVOKE signed by and sent from the new administrator. This helper freshly verifies the receipt, transaction sender/type/version/signature shape, canonical accepted block and matching new-account class/public key at the receipt block as well as current head. Wrong sender, reverted/pending receipt, class/key drift, missing transaction or canonical block mismatch stops renunciation. Historical receipt evidence plus the explicit acknowledgement is not a guarantee the operator still has access; recheck actual KMS access and review any delay before signing.

Only then prepare old-account renunciation:

```sh
python3 infra/aws/lean/readiness/registry_handoff.py prepare-renounce \
  --private-input /private/kamui/handoff-input.json \
  --private-output-directory /private/kamui/handoff-renounce \
  --new-controller-confirmed
```

The helper freshly checks both new roles, the registry/new-account class and full public key pins, the controller receipt evidence, and requires the explicit controller acknowledgement. It writes `renounce_role(REVOKER_ROLE, oldAccount)` followed by `renounce_role(DEFAULT_ADMIN_ROLE, oldAccount)`, to execute **from the old account** in one reviewed batch. There is no automatic broadcast. Do not remove the last working administrator before the new controller/roles are confirmed. If ownership or governance differs, stop and review rather than adapting calldata blindly.

After the owner signs and waits for accepted success:

```sh
python3 infra/aws/lean/readiness/registry_handoff.py verify \
  --private-input /private/kamui/handoff-input.json \
  --private-output-directory /private/kamui/handoff-final
```

Final verification requires both new roles present and both old roles absent at one observed accepted block hash, with the expected registry/new-account classes, full controller public key, canonical successful controller proof and role administrators. Output files are exclusive and cannot silently overwrite earlier evidence. Read-only methods are hardcoded; no private-key loading, signing, invoke or deploy path exists. Recheck class, JWK/audience state, revocation counters and watcher behavior independently. Role transfer does not replace the registry or account class. No role transfer has been executed by this work.

## 4. Operator-only resource and address actions — after review

Use the already prepared [provisioning template](../scripts/provision.example.sh) only after the AWS owner approves the concrete private inputs. It provisions the chosen host using existing reviewed objects; it does not create accounts, security groups or policies. The agent does not run it. Set its required variables privately, with the appropriate existing profile, and run once for each role:

```sh
KAMUI_ROLE=backend /opt/kamui/lean/scripts/provision.example.sh
KAMUI_ROLE=pepper /opt/kamui/lean/scripts/provision.example.sh
```

Do not reuse one host's profile/network variables for the other account. Never print private launch results; the template retains them in `OPERATOR_PRIVATE_DIRECTORY`. Inspect the result privately, wait for EC2/SSM readiness through the approved operator access path and verify the actual AMI/root-device/volume/metadata settings. No inbound SSH is proposed.

For stable DNS, prefer an existing approved Elastic IP for each host. If a new allocation is approved, the operator runs the following **paid resource actions**, using task-specific variables loaded privately from reviewed launch/allocation records. These commands are not executed by the agent:

```sh
umask 077
aws ec2 allocate-address --domain vpc --profile "$AWS_PROFILE" --region eu-west-1 \
  > "$OPERATOR_PRIVATE_DIRECTORY/address-allocation.json" \
  2> "$OPERATOR_PRIVATE_DIRECTORY/address-allocation.log"
# Set KAMUI_ALLOCATION_ID and KAMUI_INSTANCE_ID privately from the saved records.
aws ec2 associate-address --allocation-id "$KAMUI_ALLOCATION_ID" --instance-id "$KAMUI_INSTANCE_ID" \
  --profile "$AWS_PROFILE" --region eu-west-1 \
  > "$OPERATOR_PRIVATE_DIRECTORY/address-association.json" \
  2> "$OPERATOR_PRIVATE_DIRECTORY/address-association.log"
```

Use a separate private directory per role and do not overwrite earlier records. If allocation succeeds but association fails, preserve the result and have the operator inspect/reuse or release that exact unused allocation; it remains billable. An auto-assigned IP can change on stop/start, so an unreviewed ephemeral address is not a stable DNS plan. [EC2 Elastic IP guidance](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/elastic-ip-addresses-eip.html)

## 5. Install the reviewed release with funding still off

Build/publish through the organization's approved image process, review notices/scans/base and result digests, and prepare the private digest-only manifest. Follow [host installation](../README.md#operator-host-installation): code, public configuration and private consumer mounts are distinct; no build/start step receives a signing key as an argument or reads the developer secret file.

Install the backend boot fence **before** full stack startup. Initialize only an empty fresh database or use the explicit stopped-API migration/restore procedure. Preserve the whole restore-gate directory, canonical database path and old data. Confirm an offline/manual registry mode does not mount an administrator key on the server or start the hot rotator. The package requires no `OWNER_ADDRESS` and rejects a leftover administrator-key file. It also sets the legacy-named `REQUIRE_OFFLINE_REGISTRY_ADMIN=true`: this means registry authority is off the API server, not that the selected KMS custody is air-gapped. The API refuses before reading its signing key if its relayer retains either registry role. Independently review effective host/instance-role policies to ensure neither host nor any API/watcher/backup/monitor credential can invoke `kms:Sign` for the administrator key, assume the operator identity, change its policy or disable/delete the key. Do not install an administrator AWS profile, access key or signing script on the hosts; this startup flag does not inspect IAM/KMS permissions. This initial trusted-RPC observation does not prove who controls the new administrator or protect against later role drift.

Start PostgreSQL alone, establish reviewed S3 backup access and perform a real repository backup plus disposable restore before enabling fees. The existing local POSIX drill is evidence for the wrapper, not AWS/S3. Select retention/backup-age objectives and actual alert delivery, then enable their reviewed schedules. `systemctl enable` of a timer is not proof a page reached an operator. Keep all funding operations zero/paused until those gates and threshold review pass.

## 6. DNS, TLS and Google acceptance

The DNS owner creates **DNS-only A records**:

| Name | Value |
|---|---|
| `sepolia.kamui.page` | Reviewed stable backend public IPv4 |
| `pepper-sepolia.kamui.page` | Reviewed stable pepper public IPv4 |

Do not point apex/production records at these test hosts. Do not add AAAA records until IPv6 routing/ingress and privacy behavior are reviewed. Verify authoritative propagation, then actual Caddy certificate issuance/renewal, exact hostname validation and refusal of private/metrics/legacy paths. Neither records nor certificates were created here.

The Google OAuth owner registers exactly `https://sepolia.kamui.page/callback` on the **existing intended client**, with reviewed public-beta consent/audience settings. Do not alter the Google client ID just to fix callback errors. No Apple setup is requested. Check `/config.json` contains explicit public RPC/issuer/class/registry/executor/pepper values only and no credentials or local origin.

Repeat user-assisted Google recovery and approved-app/wallet funding acceptance at HTTPS, with PostgreSQL restart/pause/refusal checks, browser resource evidence and private incident traces. Confirm spoofed forwarded headers cannot select buckets, no sensitive token/query/body reaches proxy logs, and only Caddy ports are externally reachable. Actual cloud ingress, credentials, SMS/pager delivery, TLS, browser proof performance and uptime/cost behavior remain unverified until those checks run.

## Current verification

Twelve offline readiness/unsigned-handoff tests and two capture-only JWK planner tests passed; standalone planner TypeScript checks passed. Eight updated host-package tests passed with no default hosted rotator/admin source. The example review record intentionally reports missing decisions; the private AWS-input template intentionally refuses before any call. A read-only public Sepolia observation confirmed the expected registry AccessControl ABI and default role administrators. No AWS inventory, signer transaction, image publication or hosted acceptance was performed. The main [local validation record](../VALIDATION.md) remains separate from deployment acceptance.

## Off-server Google JWK updates

After the handoff has been verified, use the reviewed workstation with Bun 1.4.4 and installed backend dependencies. The input is the same private handoff JSON containing only public addresses/class hash. The start block comes from the reviewed registry deployment record; it must include the complete relevant key history. Use a fresh output filename each time:

```sh
/Users/adrienlacombe/ws/kamui/spikes/s1/tools/node_modules/.bin/bun \
  infra/aws/lean/readiness/prepare-jwk-updates.ts \
  /private/kamui/handoff-input.json 18030487 /private/kamui/google-jwk-update.json
```

On another operator workstation use its reviewed Bun executable. Run the final Python `verify` command first to recheck the recorded successful controller proof. The planner verifies Sepolia, the expected registry class, the new administrator class/full k1 public key, and that the new account has both roles while the old account has neither. Its matching config now requires the recorded proof hash, but receipt verification itself remains the Python helper’s task. It reuses Kamui's key-comparison logic, but replaces execution with a unique capture exception **before** receipt waiting or an `updated` log. It never loads an owner key, signs, broadcasts or simulates an accepted transaction. It writes an exclusive `0600` unsigned call file, and stdout reports only status/count.

The plan is based on multiple current public reads, not an atomic snapshot or guarantee that the issuer/registry will remain unchanged. Reprepare/recheck immediately before signing if it was delayed. Review it in the independent administrator's normal wallet. Additions copy only eligible published RS256/2048-bit keys; replacements/removals can invalidate every in-flight proof or pending override and need a maintenance decision. The tool does not automatically approve them. After signing through the approved wallet, wait for actual accepted successful receipts and independently verify registry/watcher state. If no calls are needed, the plan has an empty call array and nothing should be signed.

The automatic watcher is an observer, not an administrator. Its missing-published-key check and actual alert delivery need acceptance so that new Google keys do not wait unnoticed. Review the human response rota and recovery availability before open access.
