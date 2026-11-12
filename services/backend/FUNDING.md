# Durable paid-attempt limits

PostgreSQL mode uses `FUNDING_POLICY_FILE` for sponsorship, first deployment and recovery. New databases start **paused**. A missing policy or the committed zero-valued [example](funding-policy.example.json) disables all paid work. Limits and credential ownership require wallet/security and funding-operator review; no live funds or approvals are supplied here. SQLite remains development compatibility and uses its historical in-memory accounting.

## Policy and app authentication

The policy has `global`, `operations.sponsor`, `operations.deployment`, `operations.recovery`, `apps`, and `allowExternalPaymaster`. Every limit contains `periodSeconds`, `txPerPeriod`, `perAccountPerPeriod`, `maxFeePerTx`, `maxFeePerPeriod`, and `perAccountMaxFeePerPeriod`. Fee values are decimal or hexadecimal strings in fri; counts and durations are whole numbers. Each app is keyed by its public app key and has the same limits plus `credentialHash`, a SHA-256 hex digest of a strong random server credential. Do not put the bearer credential in policy JSON, Git, browser configuration or screenshots.

An approved app's **server** sends its public identifier in `x-kamui-app-key` and private credential in `x-kamui-sponsor-token`. Anonymous sponsorship is off. A public key, Origin header or fee-valid session signature alone does not establish app authorization. The keychain proxy forwards caller credentials only on `POST /api/sponsor`; it never injects a privileged server credential into public browser requests. Approval of an app does not authenticate that app's end users: the app's server must control how its credential is used. The account remains the authority over call signatures/scopes.

Ping supports optional server-only `SPONSOR_SERVER_TOKEN_FILE` or `SPONSOR_SERVER_TOKEN`, and never exposes it through `/config.json` or browser JavaScript. It ignores a browser-supplied sponsorship token. This is an integration example, not an automatic approval or an end-user authentication system.

**Current wallet limitation:** the keychain's own session-management/owner-approved sends do not carry an app server credential. They therefore remain unfunded in this hosted policy. A dedicated owner-authorized wallet funding route needs design/review; do not solve this by embedding an app credential in the wallet or injecting it for every public request. Deployment and proof recovery have their own funding operations and limits.

## Accounting guarantees and limits

An atomic PostgreSQL transaction checks the persisted pause and rolling global, operation, app and account counts/fee sums, then commits a debit **before** a call that can broadcast. All three kinds share the global bound, with separate operation bounds. Signed deployment/recovery debits use maximum resource bounds including tip. Local sponsorship uses the checked resource bounds and an explicit zero tip. A database or journal commit failure prevents that send.

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
