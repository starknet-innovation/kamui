# Private runtime preparation

`runtime.py` prepares local files for the next installation workflow. It **does not install runtime files on either host, upload secrets, start services, acknowledge a database/restore gate, migrate a database or enable funding**. No AWS call or signing operation exists in this module.

The default private root is `~/.kamui-hosting-sepolia`. Preparation creates mode-0700 `installation/runtime/` with mode-0600 files beneath it. Keep this entire directory out of source archives, container build contexts, the public release bucket and SSM command bodies/output. Its manifest explicitly declares `publicPackageAllowed: false` and `automaticSecretUploadAllowed: false`.

## Local command and API

The numbered installation wrapper invokes:

```sh
python3 -B infra/aws/lean/install/runtime.py prepare
python3 -B infra/aws/lean/install/runtime.py validate
```

`--private-directory /absolute/private/path` selects the same permanent private root used by resource creation. Python entry points are `prepare(root, metadata=None, source_paths=None)` and `validate(root, require_external=False)`, returning fixed status/count/remaining-gate fields only. The default sources are:

- Existing backend `.env.local`: **only** `AUTHORIZED_GOOGLE_RECOVERY_CLIENT_ID` and the public `RELAYER_ADDRESS` are selected.
- Existing pepper `.env.local`: **only** `KMS_KEY_ID`, `PEPPER_KEY_CHECK` and `GOOGLE_AUDIENCES` are selected.
- Public `services/backend/deployments.env`: user-account class, existing JWK registry/block and prover executor.
- Existing private `aws-input.json`: exact selected pepper key reference and backup bucket.

`source_paths` may override `backend_env`, `pepper_env` and `deployments` with private file paths; the normal command needs no override. The parser never sources/evaluates shell text, substitutes variables, reads a Secrets Manager value, or selects a backend/private signing key. Nonliteral selected values and duplicate selected fields are refused. Local private source files must belong to the caller, have no group/other permissions and not be symlinks. Public deployment pins must match the reviewed Sepolia values; no automatic account/registry/key migration occurs.

## Output and restart behavior

Backend output includes public service configuration, a zero-limit funding policy, pgBackRest configuration and four generated database-secret files. Random PostgreSQL superuser/application passwords are generated once; both application URLs identify the same non-superuser `kamui` account/database and password. Existing files/passwords are reused only when they match the retained state; no reset or overwrite operation is supplied. A changed source pin or edited prepared file stops. Preserve incomplete files after interruption rather than deleting them to force new database credentials.

Pepper output contains the existing key reference/check and the one selected Google audience. These are not HMAC key material, but remain private operational metadata. The existing KMS key and the local test configuration are never changed.

`manifest.json` lists exact managed paths, hashes and **target-host** ownership. Workstation files remain caller-owned mode0600. On the host, the established package requires:

| File | Target UID/GID | Mode |
|---|---:|---:|
| PostgreSQL/application password and pgBackRest configuration | 999 | 0400 |
| API application URL and funding policy | 1000 | 0400 |
| Operator application URL | 0 | 0400 |
| Per-service env files and backup operator settings | 0 | 0600 |
| Separately delivered relayer signing file | 1000 | 0400 |

Target directory traversal/consumer access must also follow the host package; this metadata is not a substitute for actual host permission checks. The backup operator acknowledgement/retention/objective fields remain empty, and alert delivery is not configured or claimed. The funding policy has zero transaction/FRI limits, no approved apps and external paymaster disabled; this is **not** a claim about an existing database's persisted pause/history.

## Existing signer delivery remains separate

`existing-secret-files.json` starts as a paths-only mapping with `backend.RELAYER_PRIVATE_KEY: null`. An operator may record an existing private source path through their normal private delivery process. Validation can check that path's ownership/type/permissions/size using `stat`; it never reads, copies, hashes or uploads the signing value. `--require-external-source` refuses a missing source mapping. A source mapping is neither key validity nor proof of delivery to `/etc/kamui/secrets/RELAYER_PRIVATE_KEY`.

No signer is bundled into the generated configuration. Unexpected files under either role directory, including an accidentally placed relayer key, are refused before being read or added to the manifest. Do not paste a signing key into a shell command, chat, SSM parameter, image or archive. Do not install a registry administrator identity on either server.

After approved private runtime/secret delivery, real acceptance still requires the registry role handoff, correct host consumer permissions, stopped-writer database/schema/restore checks, real backup restore and alert review, and explicit startup. Every report keeps `startupReady: false`; preparation cannot bypass these controls. The selected sole-KMS registry administration remains Sepolia-only, not the mainnet custody design.

## Verification

```sh
python3 -B -m unittest discover -s infra/aws/lean/install -p test_runtime.py
```

Eleven offline tests use synthetic metadata/private temporary directories. They cover idempotent password reuse, matching URLs, strict public/key pins, no shell evaluation, zero funding, exact ownership metadata, missing/edited manifests, source permissions/symlinks, rejecting accidental signer files without reading them and paths-only signer checks. No AWS request, remote installation, secret delivery or service startup was tested or performed here.
