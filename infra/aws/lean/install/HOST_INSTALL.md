# Host installation boundary

`host_install.py` runs **on the selected AL2023 x86 host as root**, after the operator's workstation delivers the reviewed public package, its manifest and the pinned Compose binary. It makes no AWS API call and accepts no runtime secret or private signing key. The workstation's numbered installation workflow supplies these paths; do not paste AWS metadata, runtime files or private command output into Git/chat.

The delivery bootstrap must independently check the installer's own SHA-256 before execution. The expected manifest SHA-256 must come from the reviewed workstation command, not another downloaded file. A package and manifest downloaded together do not authenticate one another without that independent pin.

## Interface

```sh
sudo python3 /private/staging/host_install.py \
  --role backend \
  --archive /private/staging/public-lean.tar.gz \
  --manifest /private/staging/install-manifest.json \
  --manifest-sha256 "$EXPECTED_MANIFEST_SHA256" \
  --compose-binary /private/staging/docker-compose-linux-x86_64 \
  --compose-sha256 "$EXPECTED_COMPOSE_SHA256"
```

Use `pepper` for the pepper host. No identifier, token, password, private key or application environment value is a command argument. The arguments above are public hashes and private file paths.

The strict manifest schema is:

```json
{
  "schema": "kamui.host-install.v1",
  "role": "backend",
  "archiveSha256": "<64 lowercase hex>",
  "files": {
    "scripts/host.py": {"sha256": "<64 lowercase hex>", "mode": "0644"}
  },
  "releaseImages": {
    "CADDY_IMAGE": "<reviewed repository>@sha256:<64 lowercase hex>",
    "KEYCHAIN_IMAGE": "<reviewed repository>@sha256:<64 lowercase hex>",
    "BACKEND_IMAGE": "<reviewed repository>@sha256:<64 lowercase hex>",
    "POSTGRES_IMAGE": "<reviewed repository>@sha256:<64 lowercase hex>",
    "PEPPER_IMAGE": "<reviewed repository>@sha256:<64 lowercase hex>"
  },
  "compose": {"version": "v2.40.3", "sha256": "<reviewed binary SHA-256>"}
}
```

This excerpt omits required runtime files; it is not an executable manifest. The packaging step supplies the complete hash/mode map. Archive entries are `lean/<relative path>` regular files/directories only. The installer rejects absolute/traversal paths, extra/missing/duplicate files, symlinks, hardlinks, devices, PAX metadata and private/runtime paths. Only `0644`/`0755` file modes are accepted. Runtime shell entrypoints must be executable. Use normalized USTAR headers rather than unreviewed extraction commands.

## What installation changes

- Verifies every public file and archive/Compose pin before any system command.
- Requires AL2023 x86 and an already active SSM agent. The standard `/etc/os-release` symlink is accepted only when it points to `/usr/lib/os-release` (absolute or the standard relative form), and that canonical file is root-owned and not group/world writable; other installation-target symlinks remain refused. AWS's [SSM Agent documentation](https://docs.aws.amazon.com/systems-manager/latest/userguide/agent-install-al2.html) says the standard AMI commonly includes the agent; that does not prove it is installed/running or connected on a particular host.
- Installs Docker, if absent, from the selected AL2023 signed package repository (`dnf -y install docker`) and AWS CLI v2, if absent, as package `awscli-2`. No full system update, `--releasever=latest`, Docker-group grant, unsigned shell download or new AWS credential is used. AWS documents [Docker installation on AL2023](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-docker.html) and the [`awscli-2` package](https://docs.aws.amazon.com/linux/al2023/release-notes/vercmp-AL2-AL2023.12.html).
- Existing and checked installer-managed files must be regular, have one link, be owned by root:root, and match their exact mode: Compose `0755`, units `0644`, release/receipt `0600`, and package files their pinned modes. Matching bytes alone do not make a user-writable file trusted. Public release directories must also remain root-owned, non-symlink and not group/world writable.
- Installs the independently pinned Compose ELF binary in `/usr/local/lib/docker/cli-plugins/docker-compose`, verifies its SHA-256 and exact v2 version, and refuses replacement of a different installed binary. The installer never fetches a mutable `latest` binary.
- Starts **Docker only** on a pristine Docker host. Existing containers, enabled/active Kamui units, unknown Docker data and custom daemon settings stop installation without killing anything. Docker commands are bound to the local Unix socket rather than an inherited remote Docker context.
- Installs the immutable package at `/opt/kamui/releases/<archive-sha>/lean` and links `/opt/kamui/lean` to it. A different release requires a separate reviewed upgrade; it is not silently replaced.
- Writes only the digest-pinned `/etc/kamui/release.env` configuration. It creates consumer directories, PostgreSQL's `999:999` directory and the backend gate directory as root:GID 1000 mode `0750`. Existing data, gate files, configuration, secrets and differing directory layouts are preserved/refused, never reset or silently re-owned.
- Installs the role's existing stack/monitor units plus backend boot-fence/drop-in and backup units. It runs `daemon-reload`, but **does not enable or start Kamui, PostgreSQL, backup or monitoring units**, initialize a database, acknowledge a restore gate, pull app images, unpause funding or change registry authority.

System-command diagnostics are retained under root-private `/var/log/kamui-install`. The receipt is `/var/lib/kamui-install/<role>.json`, mode `0600`, bound to exact manifest/archive hashes. A repeated identical installation verifies existing package/unit/release files without replaying package-manager or service commands. A partial installation can resume only if preserved files match the same release; no override/reset mode is provided. This is a first-install helper, not a host upgrade or disaster-recovery procedure.

## Read-only installation check

Run the same arguments with `--check`. It checks the pinned package, immutable receipt, installed units/release file, local Docker, Compose hash/version, CLI v2 and active SSM agent. It does not install dependencies, start services or write diagnostics. It prints a fixed result with `runtimeConfigurationVerified: false`.

This check does not establish runtime secret delivery, PostgreSQL initialization/migration, the boot/restore acknowledgement, S3 backup/restore, registry role separation, TLS/DNS/Google, actual funding policy or delivered alerts. Those remain explicit later acceptance steps. The Sepolia custody decision is not mainnet authorization.

## Local verification

```sh
python3 -B -m unittest discover -s infra/aws/lean/install -p test_host_install.py
```

Seventeen tests use a temporary filesystem and fake system commands. They cover archive attacks, hash failures before command execution, preservation of data/secrets, inactive-unit installation, expected consumer ownership requests, first/repeat/read-only checks and tampering. The fake-root tests replace the ownership predicate/file-owner setter; production always requires root:root. Tests do not install software, change ownership on the workstation, call AWS, execute a remote command or prove real Linux consumer permissions. Host installation, repository access and actual production readiness remain unperformed by implementation.
