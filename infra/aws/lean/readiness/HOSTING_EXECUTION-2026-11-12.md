# Lean Sepolia hosting: ordered operator execution

12 November 2026. The user requested the registry handoff, hosting and Google-only beta work in parallel. KMS signing and the native administrator account passed [run 13](../../../../spikes/s1/results/run-13-kms-admin.md). Hosting execution remains blocked by unselected AWS resources, effective-permission/custody review, release image digests and the user-run provisioning steps below. No AWS provisioning, security setting, DNS change, image publication or hosted acceptance was performed here. The earlier Fargate Terraform is not this deployment.

The operator is the user. These are workstation/host commands for the operator, not permission for the agent to change AWS settings. Sensitive AWS metadata stays in private local files; do not paste it into chat or Git. Never enter a signing key into any command or helper. The hosted services receive their reviewed runtime secrets through the existing private delivery process; no administrator KMS identity belongs on a host.

## Start here when resources are missing

The [ordered resource setup](../setup/README.md) now fills the private selections from retained local records and official AMI discovery, creates dedicated network/role/backup resources and verifies the exported input. From the repository root:

```sh
./infra/aws/lean/setup/00-setup-aws-resources.sh
```

This user-run command executes prepare/network/identity/export only; it does not launch hosts or allocate IPs. After reviewing the prepared account-aware plan, the optional `05-launch-hosts.sh` and `06-addresses.sh` in that directory replace the manual host-launch/address commands below. Use one path and preserve the same private launch intents; never run both paths to duplicate a host. DNS/OAuth, immutable images, runtime configuration and hosted acceptance still follow this runbook.

## 1. Create the private selection file

From the repository root, run once:

```sh
umask 077
mkdir -m 700 "$HOME/.kamui-hosting-sepolia"
python3 -B infra/aws/lean/readiness/prepare_private_input.py \
  --private-directory "$HOME/.kamui-hosting-sepolia"
```

The helper makes `aws-input.json` mode `0600`, exclusively, with **no AWS calls**. If the directory/file already exists, inspect and reuse it; do not recreate it to hide an earlier launch intent. Profiles and Ireland are already filled. Edit that file privately using the normal local editor. Empty resource fields must be selected, not inferred from whichever object appears first in AWS.

| Private input | Required operator selection | Recommendation |
|---|---|---|
| Each account: `expected_account` | Trusted expected identity, independently checked against the existing test-account records | Keep backend and pepper in their existing separate accounts. Do not use a current STS response as its own approval. |
| Each account: `ami_id`, `approved_ami_owner` | Maintained x86 Linux image and trusted publisher | Reviewed Ubuntu LTS or Amazon Linux image with a documented Docker Engine/Compose v2, Python 3 and systemd installation. The launch helper rechecks image ID/publisher and reads the root-device name from it. |
| Each account: `subnet_id`, `security_group_id` | Public routed subnet and dedicated web ingress group | TCP 80/443 only, no inbound SSH/API/database/metrics; operator access through reviewed Session Manager. These objects must already exist or be created by the AWS operator first. |
| Each account: `instance_profile_name` | Reviewed host instance profile | Separate backend backup/SSM and pepper HMAC/SSM permissions. The three registry KMS operator profiles are **not** EC2 instance profiles. Neither host may sign/administer the k1 key, assume its operator roles, or reach their bootstrap identity. |
| Backend: `backup_bucket` | Private S3 pgBackRest repository in the selected Region | Dedicated backup prefix/bucket, encryption, full public-access block, least-privilege backup role and reviewed seven-day retention. Repository/WAL retention and lifecycle rules require an actual restore test. |
| Pepper: `pepper_key_id` | Existing customer HMAC key's immutable reference, kept private | Reuse the existing pepper key; do not create/rotate/replace key material for hosting. Confirm its actual Region before proceeding. |

The helper can safely create the skeleton but cannot safely choose these resources or attest effective IAM/KMS/SCP permission isolation. No actual account inventory result is claimed in this package.

## 2. Inspect the selected existing resources

```sh
python3 -B infra/aws/lean/readiness/inspect_aws.py \
  --private-input "$HOME/.kamui-hosting-sepolia/aws-input.json" \
  > "$HOME/.kamui-hosting-sepolia/aws-observations.json"
```

A nonzero exit is a stop. The result contains fixed check labels, no resource identifiers. The inspector verifies both independently pinned account identities before resource reads, two distinct accounts, selected AMI/network/profile shapes, existing pepper key metadata and S3 metadata. It does not read secrets or mutate anything. It now uses private regular JSON request files instead of the installed CLI's unreliable `/dev/stdin` input mechanism, strips credential/endpoint overrides, fixes named profiles and disables SDK/CLI retries and metadata fallback. Temporary request files are removed after each read.

Complete the private technical review in [review.example.json](review.example.json), following [REVIEW_DECISIONS.md](REVIEW_DECISIONS.md). Do not set acceptance flags to make a checker green. Passing inventory does not inspect effective role trusts, cross-account assume-role paths, IMDS reachability, customer key policies, SSM access, quotas or patch/image trust. An instance-profile name is not evidence of least privilege. The backend's initial on-chain relayer-role check is separate from AWS permission isolation.

Before public launch, specifically review container access to host role credentials: the proposed IMDSv2 hop limit is two for bridge networking, but that does not separate API/keychain/Caddy/backup credentials. Review or implement host metadata restrictions and test them. Do not install administrator role profiles, signing tools or bootstrap credentials on either host.

## 3. Publish a reviewed immutable release

The [numbered installation workflow](../install/README.md) now automates release publication and public host installation with `07-build-release.sh` through `10-verify-installation.sh`. It uses additive release-only ECR/S3/IAM stacks and SSM rather than manual copy/registry selection. Keep the same private setup state and commit/review the source first. It prepares private runtime files locally but does not deliver them, start PostgreSQL/Kamui, acknowledge gates or enable funding. The manual commands below remain reference procedures; do not mix them with an uncertain numbered operation.

Use the image-build commands in [lean/README.md](../README.md#images-and-local-preparation) on a workstation/CI. Review/pin base images and architecture, vulnerability results and license notices before publishing through the existing approved registry process. No image publication command is guessed here because the organization's registry destination/access procedure is not selected.

Prepare private `release.env` from [release.env.example](../release.env.example), using only immutable `@sha256:` image references. Keep the approved source revision, manifest and prior release together. Do not build or pull mutable `main` on a host. Registry handoff/control review and these build steps can progress while AWS inputs are reviewed; API startup must wait for role separation.

## 4. Launch one host at a time, as the operator

After reviewing the selected input and actual AWS/security plan, create separate private launch-result directories and run:

```sh
mkdir -m 700 "$HOME/.kamui-hosting-sepolia/backend-launch"
mkdir -m 700 "$HOME/.kamui-hosting-sepolia/pepper-launch"
python3 -B infra/aws/lean/readiness/launch_host.py \
  --private-input "$HOME/.kamui-hosting-sepolia/aws-input.json" \
  --role backend \
  --private-output-directory "$HOME/.kamui-hosting-sepolia/backend-launch" \
  --acknowledge-reviewed-plan
python3 -B infra/aws/lean/readiness/launch_host.py \
  --private-input "$HOME/.kamui-hosting-sepolia/aws-input.json" \
  --role pepper \
  --private-output-directory "$HOME/.kamui-hosting-sepolia/pepper-launch" \
  --acknowledge-reviewed-plan
```

The acknowledgement records the operator's action; it does not manufacture a security review. Each invocation rechecks both selected account/resource observations before its single EC2 launch. The launch code rechecks the expected identity, uses one `t3.medium`/30 GiB backend or `t3.micro`/10 GiB pepper, encrypted retained gp3, required IMDSv2, standard CPU credits and no inbound SSH key. Instance output/errors are private. This launch does **not** install Docker/SSM, create roles, networks, policies, buckets, keys, DNS or a stable address. Verify the selected AMI's SSM readiness and the existing reviewed network path separately.

The previous shell template now calls the same hardened `scripts/provision.py`; its environment form additionally requires independently pinned `EXPECTED_ACCOUNT`. Prefer the input-file wrapper above to avoid retyping resource selections.

**Never rerun a launch after an uncertain response.** Before the one possible `run-instances` call, the code fsyncs an exclusive `<role>-launch-intent.json` containing the exact request and random client token. CLI retries are disabled. Subsequent runs refuse the existing intent even if the original command timed out. Preserve all files and use the recorded client token to reconcile:

```sh
python3 -B - <<'PY'
import json, os
from pathlib import Path
root = Path.home()/'.kamui-hosting-sepolia'
for role in ['backend', 'pepper']:
    directory = root/(role+'-launch')
    intent = directory/(role+'-launch-intent.json')
    if not intent.exists():
        continue
    query = {'Filters': [{'Name': 'client-token', 'Values': [json.loads(intent.read_text())['ClientToken']]}]}
    path = directory/'reconcile-query.json'
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(query, output)
PY
aws ec2 describe-instances --profile kamui-backend-test --region eu-west-1 \
  --cli-input-json "file://$HOME/.kamui-hosting-sepolia/backend-launch/reconcile-query.json" \
  > "$HOME/.kamui-hosting-sepolia/backend-launch/reconciled-instances.json" \
  2> "$HOME/.kamui-hosting-sepolia/backend-launch/reconcile.log"
```

For pepper use its profile and `pepper-launch` paths. A missing instance in one response does not authorize resubmission; resolve eventual consistency and AWS request evidence with the operator. Do not delete an intent or switch result directories to retry. The client token is retained for investigation, not used for automatic resubmission.

Stable addressing is still a required operator step: recommend one Elastic IP per host, then the selected DNS-only A records. Allocate/associate using [readiness step 4](README.md#4-operator-only-resource-and-address-actions--after-review) after reviewing the private outputs; preserve allocations and reconcile failed associations rather than allocating again. A stopped ephemeral public IP is not a stable DNS plan.

## 5. Install and start with spending blocked

Connect using the existing approved Session Manager procedure. Install the exact reviewed package under `/opt/kamui/lean` and its runtime files/consumer-scoped secrets using [host installation](../README.md#operator-host-installation). Do not display secret files or render full Compose configuration. The selected AMI must have Docker Engine, Compose v2, Python 3, systemd and the reviewed SSM agent operational before these commands.

On the backend, install the boot-fence unit/drop-in before any full stack start, then:

```sh
sudo systemctl daemon-reload
sudo python3 -B /opt/kamui/lean/scripts/host.py backend validate
sudo python3 -B /opt/kamui/lean/scripts/host.py backend pull
sudo systemctl start kamui-backend-boot-fence.service
sudo python3 -B /opt/kamui/lean/scripts/host.py backend prepare
sudo python3 -B /opt/kamui/lean/scripts/wallet-control.py restore status
```

Do not acknowledge a fresh database or recovered state until the corresponding checks in [backup/README.md](../backup/README.md) pass. Use stopped-writer PostgreSQL migration for existing wallet history; fresh acknowledgement is only for a genuinely empty database. Run an actual S3 repository backup/disposable restore and test delivered alerts before enabling schedules or fees. Confirm the off-server KMS account has the approved registry roles and the API relayer has neither before full API startup. Keep funding disabled/paused.

On the pepper host after private configuration and consumer permissions are reviewed:

```sh
sudo python3 -B /opt/kamui/lean/scripts/host.py pepper validate
sudo python3 -B /opt/kamui/lean/scripts/host.py pepper pull
sudo systemctl start kamui@pepper.service
sudo python3 -B /opt/kamui/lean/scripts/host.py pepper status
```

Run the remaining backend acknowledgement/full-start/monitor steps from the existing host/backup runbooks after their real evidence is recorded; do not enable all units blindly. Each OS boot reblocks paid operation and needs operator reconciliation: see [install/REBOOT.md](../install/REBOOT.md) and `setup/14-reopen-after-reboot.sh`.

## 6. DNS, Google and hosted acceptance

Use the reviewed stable addresses for DNS-only `sepolia.kamui.page` and `pepper-sepolia.kamui.page`; no apex changes or unreviewed IPv6. The existing intended Google client needs exactly `https://sepolia.kamui.page/callback`. The DNS/Google owners make these changes and the hosted-beta workstream then verifies real certificates, route denial, production public config, Google client proving, spending pause/refusal, restart/reconciliation and browser resource behavior. Apple remains out of scope.

## Decisions that still require the operator

1. **Selected resource references and effective host permissions:** fill the private input, review actual host-role/metadata isolation and SSM access. Recommendation: dedicated web-only groups, separate minimal host roles, existing HMAC key and private S3 repository.
2. **Release publication location and trusted image/OS pipeline:** select the existing approved registry and reviewed maintained AMIs. Recommendation: publish immutable linux/amd64 artifacts and preserve an approved rollback manifest.
3. **Open-access operational acceptance:** record the actual alert recipient, backup restore objectives and delivery/restore evidence, seven-day privacy review, stable-address ownership and public abuse/egress acceptance. Recommendation: keep all funding disabled until the separate funding policy and these controls have passed.

The $100 monthly figure remains a planning budget, not an enforced AWS cap. The user's uncapped Sepolia STRK authorization does not remove AWS infrastructure review or permission-isolation requirements. No cloud-security approval flags or successful hosted results were fabricated.

## Validation

Nine inventory/review tests, four new hosting-execution tests and twelve host-package/provision tests passed locally with fake AWS transports. The new launch tests verify expected-account mismatch blocks mutation, one-shot private intent/token persistence, no retry after timeout and refusal of a second launch. No actual AWS read, paid launch, EIP operation or host installation was run by this workstream.
