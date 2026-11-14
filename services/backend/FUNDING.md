# Durable paid-attempt limits

PostgreSQL mode uses `FUNDING_POLICY_FILE` for approved-app sponsorship, owner-authorized wallet maintenance, first deployment and recovery. New databases start **paused**. A missing policy or the committed zero-valued [example](funding-policy.example.json) disables all paid work. Limits and credential ownership require wallet/security and funding-operator review; no live funds or approvals are supplied here. SQLite remains development compatibility and uses its historical in-memory accounting.

## Policy and app authentication

The policy has `global`, `operations.sponsor`, `operations.deployment`, `operations.recovery`, `operations.wallet`, `apps`, and `allowExternalPaymaster`. Every limit contains `periodSeconds`, `txPerPeriod`, `perAccountPerPeriod`, `maxFeePerTx`, `maxFeePerPeriod`, and `perAccountMaxFeePerPeriod`. Fee values are decimal or hexadecimal strings in fri; counts and durations are whole numbers. Each app is keyed by its public app key and has the same limits plus `credentialHash`, a SHA-256 hex digest of a strong random server credential. Do not put the bearer credential in policy JSON, Git, browser configuration or screenshots.

An approved app's **server** sends its public identifier in `x-kamui-app-key` and private credential in `x-kamui-sponsor-token`. Anonymous sponsorship is off. A public key, Origin header or fee-valid session signature alone does not establish app authorization. The keychain proxy forwards caller credentials only on `POST /api/sponsor` and the three self-serve routes below; it never injects a privileged server credential into public browser requests. Approval of an app does not authenticate that app's end users: the app's server must control how its credential is used. The account remains the authority over call signatures/scopes.

Ping uses a server-configured public `SPONSOR_APP_KEY` and optional private `SPONSOR_SERVER_TOKEN_FILE` or `SPONSOR_SERVER_TOKEN`, and never exposes it through `/config.json` or browser JavaScript. It ignores a browser-supplied sponsorship token. This is an integration example, not an automatic approval or an end-user authentication system.

## App self-service: usage and credential rotation

An approved app's server can act for itself on three POST routes, authenticated with the same two headers as `/sponsor`. They need PostgreSQL funding (`DURABLE_FUNDING_REQUIRED` otherwise) and pass the restore fence like every POST. Registration, limits and the first credential remain operator decisions.

| Route | Body | Answer |
|---|---|---|
| `POST /sponsor/usage` | `{}` or `{ "account": "0x…" }` | The app's limits, its debits in the current rolling period with what is left, the same for one account when named, the pause flag, and when the app last rotated |
| `POST /sponsor/token/rotate` | `{}` | `{ token, rotatedAt }`: a new 64-character credential, returned once |
| `POST /sponsor/token/revoke` | `{}` | `{ revokedAt }`: the credential ends with no replacement |

**Storage.** The policy file still holds the SHA-256 the operator issued. A rotation or revocation writes one row per app to `funding_app_credentials`: the app's identifier (the SHA-256 of its key, as in `funding_debits.app`), the SHA-256 of the new credential (NULL when revoked), the policy hash it replaced, and the time. While the row's `policy_hash` equals the policy's `credentialHash`, the row is the app's only credential and the policy's hash opens nothing. The bearer is never stored, logged or returned again.

**Operator precedence and recovery.** When the operator issues a new credential, so that the policy's `credentialHash` for the app changes, the stored row no longer applies and the policy's hash is the credential again. This is the only way back for an app that revoked its credential or lost the answer to a rotation. After an app has rotated, the operator's private copy of the original credential (`apps/<key>/sponsor-token` from `16-register-sponsored-app.sh`) is stale: it authenticates nothing, and re-running `register` with it changes nothing. Removing an app from the policy ends every credential it has.

**Checks.** The credential is compared as a SHA-256 digest in constant time, read from the database on every sponsored call, and checked again inside the accounting transaction, under the lock a rotation takes: a credential replaced between the preflight and the debit pays for nothing, and of two rotations sent with the same credential exactly one succeeds. Usage queries are filtered by the caller's own app identifier; global and per-operation totals, which would reveal other apps' spending, are not reported. The routes are limited per client and overall (`RATE_LIMITS`, name `selfserve`, default 20 and 300 a minute), and one app may change its credential 5 times an hour, counted only after it has authenticated, so knowing a public app key is not enough to use that up. Responses are `no-store`. A rotation is logged as `sponsor_credential_rotated` or `sponsor_credential_revoked` with the app's hashed budget name, never the key or the credential.

**Limits of this design.** There is one credential per app and no overlap window: the app's sponsored calls fail from the rotation until its server holds the new credential. A holder of the credential can rotate or revoke it and lock the app out; that is the same party who could already spend its budget. Rotations live in the database, so a restore from a backup taken before a rotation makes the replaced credential valid again; treat it like lost debits in the restore reconciliation below. Schema version 4 adds the table; an API older than this one ignores it and would accept replaced credentials, so it refuses a version-4 database rather than run on it.

## Owner-authorized wallet maintenance

`POST /wallet/sponsor` accepts the existing `{account, calldata}` outside-execution wire format, with no app credential. It requires the pinned account class, configured/actual chain agreement, an exact two-element current-owner signature over the actual outside-execution hash, an unused nonce and a bounded unexpired window. Every call must target that account and match an exact permitted management ABI: session grant/update, spending-policy changes, session revocation or device add/remove. Empty calls, mixed external calls, upgrade/recovery entrypoints, malformed arrays and four-element session signatures are refused. The contract remains the authority over owners and allowed state transitions.

The keychain uses this route for session approval, device management and revocations. It still sends ordinary app transaction requests to `/sponsor`; arbitrary transfers/contracts cannot use wallet funding. No server bearer is embedded in the wallet or injected by its proxy. Wallet funding has a separate operation policy and shares global/account limits. Omitted wallet policy in an older document defaults to **disabled**. Schema version 3 widens the existing funding-kind constraint transactionally without clearing debits or pause state; older APIs do not support rollback onto this schema.

Wallet paid-attempt IDs bind chain, account and outside nonce, so changing calls, padding or signature does not pay twice for the same nonce. A timeout or malformed response remains spent and must be reconciled, never automatically retried. Local fee estimates explicitly use `skipValidate:false`, all three validated resource bounds and zero tip. An unavailable database/guard, disabled funding or used nonce prevents sending.

This route needs PostgreSQL funding even in local development. SQLite compatibility does not provide a fallback wallet subsidy. The zero-valued example and initial persisted pause remain off until reviewed limits are explicitly configured. The separately authorized run-12 local policy is not a hosted spending approval.

## Accounting guarantees and limits

An atomic PostgreSQL transaction checks the persisted pause and rolling global, operation, app and account counts/fee sums, then commits a debit **before** a call that can broadcast. All four kinds share the global bound, with separate operation bounds. Signed deployment/recovery debits use maximum resource bounds including tip. Local sponsorship uses the checked resource bounds and an explicit zero tip. A database or journal commit failure prevents that send.

Timeouts, bad responses and accepted reverts remain debited. There are no automatic refunds. An attempt may consume quota without ever reaching the network, including a crash between debit and broadcast; this is deliberately conservative. Deterministic transaction-hash debits reject repeat sends. Sponsors use independent paid-attempt IDs, so the caller must reconcile a lost answer before retrying. Changing policy does not erase retained history; debit rows are not automatically pruned. Review data growth and retention before operating a long-lived beta.

The legacy in-memory sponsor count preflight is an additional restriction; PostgreSQL is the durable count/fee authority. Generic HTTP attempt limits remain in memory and can reset after restart. These application controls do not cap bandwidth bills, protect a server against upstream denial of service, or establish an absolute AWS spending ceiling.

AVNU cannot carry Kamui's signed resource bounds through the current adapter. External sponsorship is refused unless `allowExternalPaymaster` is explicitly enabled after external-controls review. The recorded AVNU fee debit is a **preflight allowance**, not a bound on AVNU's actual final charge. Separately verify its operator spending limits, authorization and terms. No local fallback after external uncertainty.

## Pause, resume and incidents

For immediate containment, stop the API through its supervisor. Confirm it exited and cannot restart automatically. With private PostgreSQL configuration available, persist the pause:

```sh
bun run src/scripts/spending-control.ts --api-stopped pause
```

Restarting the API then allows reads while paid work remains paused. `status` reports only the pause flag. To resume after review, stop the API again, ensure the restore gate is ready and the policy is approved, run the same command with `resume`, then start one API. The command takes the same writer lease, refuses a running API and reads no signing key. Its `--api-stopped` acknowledgement cannot discover independent signers. It loads only the database runtime file when `DATABASE_URL_FILE` is configured.

Database pause and the host restore fence are independent. A stale restore may lose debits or a pause; the external restore gate must remain blocked until signer history, uncertain journal intents, registry replay history and funding state are reconciled conservatively. Stop the API and rotator before restore; a database lock cannot fence a Starknet send already prepared by an old process. See [POSTGRESQL.md](POSTGRESQL.md) and the [backup runbook](../../infra/aws/lean/backup/README.md).

## Validation

Explicit disposable-PostgreSQL tests exercise concurrent limits, fee/count scope boundaries, policy parsing, app authorization before RPC, restart persistence, pause/resume, duplicate hashes, ambiguous local/external responses, debit/journal/send ordering and a restore fence appearing before broadcast. No live funding, cloud deployment or external-provider spending-limit validation is claimed.
