# AVNU sponsorship

The optional transport in `src/services/sponsor/paymaster.ts` sends Kamui's existing signed SNIP-9 v2 payload to an unmodified AVNU paymaster over the SNIP-29 HTTP API. `/sponsor` remains the browser-facing gateway. Its app budgets, account-class check, rate limits and local preflight estimate still run. The paymaster API key stays in the backend. No AVNU implementation is copied, adapted or linked into Kamui.

This Sepolia integration passed a managed-AVNU live run on 2026-11-12: owner session approval, two session pings, scope/replay refusals, a lost gateway response and a budget refusal (run 9 in `../../spikes/s1/results/RESULTS.md`). A self-hosted AVNU container has not been run. It does not enable mainnet. With no `PAYMASTER_URL`, the development relayer behaves as before. When AVNU is configured, failures do not fall back to that relayer.

## What travels to AVNU

The gateway decodes the existing `execute_from_outside_v2` calldata back into the same SNIP-12 typed data. It preserves the calls, selector values, nonce, time bounds and owner or session signature. The time bounds are encoded as hexadecimal strings because AVNU's felt decoder refuses JSON numbers; their signed numeric values and message hash are unchanged. It sends `paymaster_executeTransaction` with `type: invoke` and `fee_mode: { mode: sponsored }`. It never asks the paymaster to build a new payload: a paymaster-chosen nonce would not be in a Kamui session's reserved range. Sponsored mode adds no payment call to the user's signed calls. Only `ANY_CALLER` payloads are accepted in this mode, since Kamui's preflight relayer and AVNU's submitting relayer are different accounts.

AVNU receives the account, calls and signature, not the login token, pepper or device private key. This added recipient of transaction data needs privacy review before production.

A submission gets one outbound attempt, bounded to 30 seconds including the response body. Any non-success, invalid response or timeout is `502 PAYMASTER_SUBMISSION_UNCERTAIN`. The gateway keeps the reserved budget debit on these outcomes, because the paymaster may already have submitted a paid transaction. It never retries automatically. Inspect the account nonce and chain before manually retrying with a newly signed payload. Successful submissions return the transaction hash as before; clients still wait on their Starknet provider for confirmation.

## Fee controls need review

The local relayer estimates the original outside call and refuses it above the configured app's `maxFeePerTx`. That is a **preflight check only** in AVNU mode: the estimate's resource bounds are not forwarded to AVNU. SNIP-29's sponsored execution parameters do not provide a signed relayer resource-bound ceiling. AVNU estimates with its own relayer and may have different overhead, fee settings or forwarder calls. The old development relayer's enforceable signed ceiling therefore does not carry over.

Before enabling production, the paymaster operator and security reviewer must verify its own per-transaction and total spending controls, funding isolation, supported account/interface checks, relayer nonce handling, authentication and monitoring. Kamui's in-process transaction-count budgets alone do not cap fees in the external service. Keep the external service private or authenticated so clients cannot bypass `/sponsor` and its budgets. The Sepolia-only gate stays until this and a live owner/session run are completed.

## Running a separate unmodified service

The operator prepares an upstream AVNU profile outside this repository, using AVNU's CLI and documentation. It includes signing configuration: keep it private, never paste it into a chat or commit it. Configure its RPC listener on port 12777 and its chain and provider for Sepolia. Give AVNU separate test funding and relayer configuration; this change does not create or fund accounts, import private keys, or deploy its forwarder.

For a service already running, set `PAYMASTER_URL` and, if required, `PAYMASTER_API_KEY` in the backend's gitignored `.env.local`, then restart the api. A URL may not contain credentials or query parameters. HTTPS is required except for the local `localhost`, `127.0.0.1` or compose `paymaster` host.

For the optional compose service, set `PAYMASTER_IMAGE` to a reviewed `avnulabs/paymaster@sha256:…` reference and `PAYMASTER_PROFILE_PATH` to the absolute path of the operator-prepared profile. The profile is mounted read-only; the upstream image runs with its own entrypoint and `PAYMASTER_PROFILE`. Then, from this directory:

```sh
docker compose --env-file .env.local -f compose.yml -f compose.paymaster.yml config --quiet
docker compose --env-file .env.local -f compose.yml -f compose.paymaster.yml up -d paymaster api
```

Do not print the resolved compose configuration: other service settings contain secrets. No image digest or private profile is supplied here, and the container has not been started as part of this change. The backend reaches it at `http://paymaster:12777`; a loopback port also lets an api running on the host use `http://localhost:12777`. Restrict upstream logs and tracing: the currently published RPC handler annotations include serialized execution parameters, so a verbose upstream deployment may record signed calls.

## Validation still required

The tests prove that the decoded owner and session message hashes match Kamui's original signatures, that the session nonce stays unchanged, and that malformed payloads, explicit callers, wrong classes, fee preflight refusals, budget limits, invalid responses and ambiguous failures are handled. These unit tests use fakes. The managed-service behavior was also checked in Sepolia run 9; see the public receipts and remaining limits there.

Run 9 verified owner-approved session creation, session pings, out-of-scope and replay refusals, budget refusal, and a lost successful gateway response. AVNU accepted this Kamui class's two-element owner and four-element session signatures. Still required: an AVNU-to-gateway timeout before a hash, comparison of external fees with recorded preflight estimates, operator spending controls, and independent review. Compatibility evidence applies to the tested class and managed service, not to every AVNU image or future API version.

## Sources and licence review

Reviewed on 2026-11-12:

- [AVNU repository and integration instructions](https://github.com/avnu-labs/paymaster).
- [SNIP-29](https://github.com/starknet-io/SNIPs/blob/master/SNIPS/snip-29.md) and the installed MIT starknet.js 10.8.0 `PaymasterRpc` request shape.
- [AVNU RPC server endpoint declarations](https://github.com/avnu-labs/paymaster/blob/main/crates/paymaster-rpc/src/server.rs). These confirm `paymaster_executeTransaction`; the repository's OpenRPC file still lists older method names and should not be used as the current method map.
- [AVNU LICENSE](https://github.com/avnu-labs/paymaster/blob/main/LICENSE) says GNU GPL v3; its current README's licence paragraph says AGPLv3. The discrepancy needs legal review against the exact image/source revision before deployment or distribution. Running a separate unmodified service is the project's integration decision, not a legal conclusion about the resulting deployment.
