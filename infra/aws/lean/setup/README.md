# Ordered AWS resources for the Sepolia hosts

Run these scripts on the operator workstation. They create the missing network, EC2 instance-profile and backup-bucket resources in the **existing two test accounts**. They do not create accounts, launch hosts, replace the pepper HMAC key, change registry authority or deploy the wallet. This is the lean Google-only Sepolia design; the earlier Fargate Terraform is not used.

The user accepts the present sole-KMS/shared-bootstrap administration for **Sepolia only**. Mainnet requires a separate custody/permission/recovery design and review. No command here changes the k1 administrator or grants a host access to it.

## Run in order

From this directory, the simplest path is:

```sh
./00-setup-aws-resources.sh
```

`00` runs phases 01–04 only; it does not launch billable hosts or allocate stable addresses. Or run the same prerequisite phases individually:

```sh
./01-prepare.sh
./02-network.sh
./03-identity-storage.sh
./04-export-and-check.sh
```

The wrapper stops on a failed phase. Keep the same private directory when resuming. `--private-directory /absolute/private/path` selects a different initial location; do not switch locations to bypass an existing uncertain request. Default state is under `~/.kamui-hosting-sepolia/resources-setup`, with the final selection file at `~/.kamui-hosting-sepolia/aws-input.json`. Directories are mode `0700`; files are mode `0600`. AWS identifiers and raw diagnostics stay there; output contains fixed status labels only. Do not paste private files into chat or Git.

Authenticate the already configured `kamui-backend-test` and `kamui-pepper-test` profiles through the normal local process first. An operator identity needs permission to inspect/create these exact CloudFormation resources, including IAM instance profiles and passing the reviewed role when hosts are launched later. The scripts do not grant the operator additional authority or change account security settings themselves until you run their resource-creation phases.

## What the phases do

| Phase | Result |
|---|---|
| Prepare | Privately reads the existing retained backend setup record and only `KMS_KEY_ID` from the pepper service's local configuration. Pins independently expected accounts, then checks both profile identities and their separation. Resolves and pins the official AL2023 x86 image and available zone. No cloud mutation. |
| Network | Creates or verifies a dedicated VPC/public subnet/internet gateway/route/web security group in each selected account. Only inbound TCP 80/443; no SSH, public database/API/metrics port, IPv6, NAT gateway or load balancer. |
| Identity/storage | Creates or verifies each EC2 role/instance profile and the backend's private encrypted pgBackRest bucket. Pepper's role refers to the existing exact HMAC key. It never creates, rotates or replaces a key. |
| Export/check | Produces the strict input consumed by the existing inspector/host launcher and runs the read-only checks. Existing nonempty selections must agree with verified resources; the earlier skeleton is replaced only with a private backup and a concurrent-change check. |

The default backend reference is `~/.kamui-admin-sepolia/setup-config.json`; the default pepper configuration is `services/pepper/.env.local` relative to the repository. Explicit private paths may be supplied with `--backend-record` and `--pepper-env`. The parser does **not** source/evaluate the env file or load signing keys. Never supply an AWS account identifier or key reference on the command line.

An already selected complete resource pair is verified before reuse; partial selections and collisions stop rather than mixing an arbitrary existing resource with a new one. CloudFormation owns newly created resources; export freshly checks the recorded stacks, templates, parameters and output bindings before writing the consumer input. In-place stack updates/deletes are not implemented. Existing selected resources are not silently adopted into a new stack or modified. Preserve all state and do not delete a failed stack to force this workflow to start again.

## Before and after a cloud write

Each CloudFormation create request has a durable private intent and client token written before the one possible AWS call. EIP allocation/association use durable intents and exact run tags because those APIs do not expose the same client-token mechanism. Automatic CLI retries are disabled. A successful local response is followed by read-only stack verification; a timeout or lost response is **not** evidence that creation failed.

On an uncertain response, keep all files and rerun the same phase to reconcile through read-only observations of the recorded stack/token. A pending stack remains pending. A failed/rolled-back stack or a different existing stack stops; the scripts do not update, delete or repair it automatically. Do not rename stacks, delete intent files or change private directories to send the same work again. Review raw errors only privately and redact identifiers before sharing a diagnosis.

## Permission and backup boundaries

Host profiles provide temporary EC2 role credentials. The backend role scopes backup object access to the pgBackRest repository; the pepper role scopes MAC calls to the existing key. Both use the Systems Manager managed-node baseline, which also includes its documented parameter/inventory/message access. This is not proof of effective permission isolation, an IAM audit or isolation between containers sharing a host. No registry signing profile or bootstrap credential is installed on either host. Review inherited policies/SCPs, metadata reachability and actual access before startup. See [identity/storage details](IDENTITY_STORAGE.md).

A new role's IAM policy alone may be insufficient for the existing pepper key: its key resource policy must delegate the relevant account authority or permit the role. The setup does not overwrite the key policy to make a check pass. If access is missing, preserve the existing policy and have the operator review the exact additional grant separately. Verify the existing pepper key-check value through the production pepper startup path; a matching key type or reference alone does not prove it is the correct long-lived key.

The backup bucket uses S3 AES256 encryption, full public-access blocking, enforced bucket ownership and TLS-only access. It is retained when its stack is deleted/replaced. It does **not** apply a seven-day S3 lifecycle that could sever the pgBackRest base-backup/WAL chain. Seven-day pgBackRest/log retention still needs the selected privacy/operations review and actual restore evidence. Retained storage can continue to incur charges; the planning budget is not an enforced bill cap. See [backup operations](../backup/README.md).

## Next: launch and verify the hosts

A successful resource setup creates `aws-input.json`, not a running beta. Once the account-aware resource plan is reviewed, the remaining numbered wrappers are:

```sh
./05-launch-hosts.sh
./06-addresses.sh
```

`05` uses the existing one-shot host launcher for one backend and one pepper host. `06` first waits read-only for both hosts to be running, then allocates/associates stable addresses with durable private intents and read-only reconciliation after uncertainty. Private DNS-ready results are `resources-setup/addresses/backend-verified.json` and `pepper-verified.json`; addresses are never printed. Both create paid resources; neither is run by `00`. Preserve their private launch/address records across restarts. The resource planning figure remains $100/month, not a bill cap.

These wrappers do not publish images, deliver runtime secrets, install/start the wallet stack or change DNS/OAuth. Follow [ordered host execution](../readiness/HOSTING_EXECUTION-2026-11-12.md) for immutable image publication, one-shot host launch, stable addresses, runtime configuration and boot/restore fencing. Keep sponsored operations off until the actual policy and checks pass. DNS-only records, Google's exact HTTPS callback and user-assisted sign-in remain separate operator actions.

The selected AL2023 image comes from the official public SSM parameter `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64`; the returned image is pinned once for this run. The default kernel can change over time, so this is not an immutable software version until resolved. AWS documents AL2023 among images likely to contain SSM Agent, but requires checking that it is installed and running. After launch, verify managed-node availability and `amazon-ssm-agent`, then install/verify Docker Engine and **Compose v2**, Python 3 and the reviewed host units. Resource creation alone does not install those dependencies or test SSM, MAC access, backup restore, alerts, HTTPS or Google recovery. [AL2023 AMI parameters](https://docs.aws.amazon.com/linux/al2023/ug/ec2.html), [SSM Agent checks](https://docs.aws.amazon.com/systems-manager/latest/userguide/ami-preinstalled-agent.html).

## Local validation

Run the setup tests from the repository root:

```sh
python3 -B -m unittest discover -s infra/aws/lean/setup -p 'test_*.py'
```

Tests use fake AWS transports and synthetic resource data. They do not create AWS resources, validate the operator's effective permissions or constitute deployed acceptance. The templates, policies and exact account-aware creation plan remain for operator/security review before execution.

Local result for this change: **32 setup tests**, the existing **30 readiness tests** and **12 host/provision tests** passed. Both templates pass **cfn-lint 1.60.1**; the IAM template documents one narrow W1030 suppression for its unused backend pepper-key branch. `cfn-guard` is unavailable, so no cfn-guard compliance result is claimed. Account-aware `validate-template` is part of the user-run prepare phase and has not been run against AWS by this change. No AWS operations were executed during implementation.

## Continue with installation

After `06`, use the [next numbered installation scripts](../install/README.md): `07-build-release.sh`, `08-prepare-runtime.sh`, `09-install-hosts.sh`, `10-verify-installation.sh`. To ship a new release before the wallet has ever started, run `11-supersede-unstarted-release.sh`, then `07`–`10` again. They add immutable ECR/artifact delivery, prepare runtime files locally and install/verify the public package and images through SSM. Commit/review the source before `07`; a dirty source tree is refused. Runtime secrets are not uploaded, and application/database startup remains gated separately.
