# Numbered release and installation

These are operator-run scripts for the two existing **Sepolia** hosts. They build and publish immutable images, prepare private runtime files locally, install the public host package through Systems Manager, and verify it. Scripts 07–13 do not start Kamui or PostgreSQL, copy a signing key, acknowledge a restore gate, grant registry authority, change DNS/OAuth, or enable funding. Script 14 is the exception for one case: after a host reboot it acknowledges the boot-fenced gate on the operator's interactive attestation and starts the stack ([REBOOT.md](REBOOT.md)).

The current sole-KMS/shared-bootstrap custody acceptance applies to Sepolia only. Mainnet still requires a separate KMS/permission/recovery design and review.

## Run in order

First finish `06-addresses.sh` using the corrected attachment check. Preserve the existing private directory and all intents. Commit and review the installation changes before `07`: image publication and package generation refuse a dirty tree or changed application revision. Narrow installation-helper fixes on a committed descendant may resume the existing frozen release, preserving every original intent and image tag.

From `infra/aws/lean/setup`:

```sh
./07-build-release.sh
./08-prepare-runtime.sh
./09-install-hosts.sh
./10-verify-installation.sh
```

All use `~/.kamui-hosting-sepolia` by default; `--private-directory /absolute/private/path` selects the existing setup state. Do not select a new directory to bypass an uncertain operation.

| Script | What it does |
|---|---|
| **07** | Creates additive release-only CloudFormation stacks: private immutable ECR repositories, a private artifact bucket and narrow host pull policies. Builds the committed source for linux/amd64, pins upstream base digests, verifies pinned prover assets, publishes five images, and saves private `release.env`/`release.json` including the main.js hash. |
| **08** | Prepares runtime configuration, fresh persistent database passwords/URLs and zero-limit funding policy **locally only**. Extracts only allowlisted public metadata from local configuration; no signer field is selected or copied. A paths-only external-delivery placeholder remains pending. |
| **09** | Creates content-addressed **non-secret** package artifacts, uploads only an explicit allowlist to the new private bucket, and sends one reviewed-hash SSM installation command per exact saved host. Installs Docker/CLI prerequisites, pinned Compose, immutable lean files and disabled units. Pulls the role's digest-pinned ECR images with temporary instance-role credentials. Starts Docker on a verified pristine host, but no app/database container. |
| **10** | Checks installed package/receipt/units/dependencies and local image digests. Does not publish artifacts, log in to ECR, pull images, install packages or start services. It downloads the same hash-pinned verification payload into temporary host files and sends a separate read-only check command. |
| **12** | `12-add-host-secrets.sh`: adds each host's runtime secrets, their KMS key and the host role's single decrypt path to the identity stacks, through a change set checked on a first run and applied only with `--execute`. See [SECRET_DELIVERY.md](SECRET_DELIVERY.md). |
| **13** | `13-store-runtime-secrets.sh`: stores the files from `08` in each host's secret. Never reads a value back and never touches the relayer key. |
| **14** | `14-reopen-after-reboot.sh status \| fence \| reopen --review-ref <ref> \| enable-boot \| reload-runtime`: after a host reboot. `status` is read-only on both hosts. `reopen` checks the current boot's fence marker and active fence unit, a gate blocked by this boot (reason `restore`, confirmed generation), the replay window (it waits), stopped API/rotator and zero unfinished recovery jobs, then asks you to type `REOPEN`, acknowledges in `restored` mode (your attestation) and starts the backend stack. `fence` fences a boot that was not fenced at startup. `enable-boot` enables `kamui@pepper.service` and the backend boot fence (not the backend stack) at boot. Host-side code is sent inline over SSM; no host package change. `reload-runtime` restarts an already open backend (gate ready, no unfinished recovery jobs) so it fetches the runtime files `13` stored; it never opens writes. It fetches the runtime files before PostgreSQL starts, then with writers stopped counts recovery jobs again: if one was interrupted, or the stop, fetch or recount fails for any reason, it blocks the gate instead of restarting, and writes return only through `14 reopen` after reconciliation. See [REBOOT.md](REBOOT.md). |
| **16** | `16-register-sponsored-app.sh register <app-key> \| status`: approves an app for sponsored calls. Creates its server credential in a private file under `apps/<app-key>/` (never printed) and adds the app, with its limits, to the funding decision; the policy holds only the credential's SHA-256. Apply with `08`, `13`, then `14 reload-runtime`. Give the credential file to that app's server only (`SPONSOR_SERVER_TOKEN_FILE`). See [funding controls](../../../../services/backend/FUNDING.md). |
| **11** | `11-supersede-unstarted-release.sh`: only for shipping a new release **before the wallet has ever started**. Archives the completed release, its package and the derived public runtime files (`*.public.env`, runtime `manifest.json`) under `installation/superseded/`; generated database secrets, stack and command evidence stay. Then commit the new source and run `07` → `10` again. No AWS call. |

The operator needs the existing account profiles authenticated, Docker Engine/buildx on the workstation, the current pinned keychain prover assets, and permission for these exact CloudFormation/ECR/S3/SSM operations. The hosts need to be the recorded running AL2023 x86 instances and online SSM managed nodes. No inbound SSH port is added. An unrecognized existing Docker installation, modified host package, active Kamui unit or mismatching owned file stops installation instead of overwriting it.

`07` adds release storage/permissions; it does not update the core network/identity stacks, touch either KMS key or change account-level registry scanning settings. Repositories, images and versioned artifacts incur storage costs; the $100/month figure remains a planning budget, not a cap. Review image vulnerability findings, source/base notices and the exact resource/permission plan before public launch. Publication/install success is not security or license approval.

## Secret boundary

Private local runtime files are under `installation/runtime/`. **They are never included in an image, archive, artifact upload or SSM command.** Database passwords and URLs remain in those private local files. No relayer-key field or external key-file contents are extracted by these scripts; do not paste it into chat, a command argument or an SSM command. Runtime delivery must use the approved private operator process later. No administrator key, KMS signing identity or AWS static credential is installed on either host.

The public package uses a fixed source-file allowlist, independently pinned installer/manifest/Compose hashes and a committed source revision. SSM bodies contain only artifact references, hashes and public installation code. Host command output goes to a root-private log; the workstation prints fixed status labels. ECR login passwords are held in memory, sent to Docker stdin and stored only in a temporary Docker configuration removed on completion or ordinary error. No application secret is required to pull images. The payload retains the project license and the official Docker Compose v2.40.3 LICENSE/NOTICE; review any other required third-party notices before distribution/public launch. The pinned [Compose release](https://github.com/docker/compose/releases/tag/v2.40.3) binary is independently checked against its committed SHA-256.

## Crash and failure handling

Every CloudFormation create, image push, artifact upload and SSM send has private durable evidence before its one possible mutation. Unknown results reconcile the exact original stack, image, object or command; they do not resend it. SSM SendCommand has no client token, so uncertain sends are reconciled using their unique comment and exact instance, without fetching other command output. Zero/multiple matches stop. A completed script-10 verification gets a fresh read-only check on the next explicit run; an unfinished check resumes its recorded invocation. A failed/unknown mutating operation is not fixed by deleting an intent, recreating a directory, changing a tag or sending a new command blindly.

The host installer verifies all package hashes before host mutation, refuses symlinks/traversal/extra archive files and preserves existing configuration/data. Same-package installation and `--check` verify the existing receipt. A different release is refused unless script 11 superseded the previous one; `09` then asks hosts to `--replace-unstarted`. A host replaces its install only if its receipt shows the wallet never started, `/var/lib/kamui` holds no files, no Kamui unit is active or enabled, no container exists and every installed unit still matches the previous release. It records the replaced receipt, swaps the package link atomically and resumes safely after interruption. Upgrading a started wallet remains a separate reviewed operation. If runtime files were already delivered by hand, deliver the regenerated public files again. Preserve private logs and state if an interrupted package/host operation needs investigation.

## After script 10

Success means **public package and images installed; runtime and startup still pending**. Remaining work is deliberately visible:

1. Complete the exact reviewed registry handoff so the API relayer has neither registry role.
2. Deliver consumer-scoped runtime/secret files using the approved private process; never upload the local runtime directory to the artifact bucket.
3. Perform the fresh/migrated/restored PostgreSQL procedure, real backup/restore and alert acceptance, then explicitly acknowledge the correct gate. Do not treat existing data as an empty database.
4. Configure DNS-only records and Google's HTTPS callback, verify certificates and the fixed-origin acceptance checks, then enable only the separately reviewed funding policy.

The initial host role still provides a shared credential boundary across that host; image pulling does not prove per-container IMDS isolation. The existing startup gates, off-server KMS custody and mainnet review requirements are unchanged. See [host acceptance](../../terraform/HOSTING_ACCEPTANCE.md) and [ordered execution](../readiness/HOSTING_EXECUTION-2026-11-12.md).

## Details and validation

- [Release publication](RELEASE.md)
- [Host installer](HOST_INSTALL.md)
- [Private runtime preparation](RUNTIME.md)
- [Host reboot and reopening backend writes](REBOOT.md)

```sh
python3 -B -m unittest discover -s infra/aws/lean/install -p 'test_*.py'
```

Tests use fake AWS/process/host transports and synthetic credentials. CloudFormation lint covers the release template. No live AWS operation, image build/push, remote install, private runtime delivery or hosted wallet startup was executed while writing this package. cfn-guard and service-side account validation are not claimed by local tests.

Implementation validation on 13 November 2026: **50 installation tests**, **34 resource-setup tests**, **30 readiness tests**, and **12 host/provision tests** passed (**126 total**), plus shell syntax, release-template cfn-lint 1.60.1 and private-identifier/credential scans. These are local/fake-transport results, not live AWS/image/host acceptance.

Runtime metadata source files that also contain secrets must remain mode `0600` or stricter. A too-open source now reports `RUNTIME_PRIVATE_SOURCE_PERMISSIONS_REQUIRED`; the checker is not weakened. Local metadata parsing reads the source file inside the private process and retains only its public allowlist; private signer-file mapping remains paths-only and is never bundled or uploaded.
