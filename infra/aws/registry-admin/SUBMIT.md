# Bounded KMS-admin Sepolia submission

Prepared, **not run live**. `submit.ts` is a separate, explicitly invoked paid-test sender. It never loads a private key, contacts KMS, creates a key, funds an account, declares a class, or changes registry roles. It accepts only an original V3 `DEPLOY_ACCOUNT` for the pinned KMS admin or one empty-calldata `ping()` on the existing Sepolia test target `0x2f8ce9fcc5f6e165ab5dcccf865c4c08e7d752d6b930938195683eef9f43dfc`. Query signatures, other targets, extra calls, nonempty calldata and registry calls are refused.

Use this only after the dedicated key, class declaration, any necessary funding, validated fee estimation, custody/security review and exact operator signing have been completed. The user approved a test envelope of **at most four paid attempts, 12 test STRK total including funding principal, and at most 5 STRK in fees per attempt**. All declaration/funding/deploy/Ping attempts must share the same original durable journal. This sender does not expand that authorization or authorize a registry handoff.

## Operator commands

Run from `infra/aws/registry-admin`, with the repository's Bun 1.4.4. Select the same permanent private journal initialized for this test, and use private files in operator-owned directories. These are commands for the operator, not actions performed during preparation:

```sh
export KAMUI_BUN=/Users/adrienlacombe/ws/kamui/spikes/s1/tools/node_modules/.bin/bun
export KAMUI_KMS_LIVE_JOURNAL=/private/kamui/kms-sepolia-budget.json

"$KAMUI_BUN" live-budget.ts inspect --journal "$KAMUI_KMS_LIVE_JOURNAL"
"$KAMUI_BUN" operator.ts check --input /absolute/private/operator-input.json
"$KAMUI_BUN" operator.ts sign --input /absolute/private/operator-input.json \
  --output /absolute/private/operator-signed.json

"$KAMUI_BUN" submit.ts send --input /absolute/private/operator-input.json \
  --signed /absolute/private/operator-signed.json \
  --journal "$KAMUI_KMS_LIVE_JOURNAL"
```

There is **no journal initialization, reset, refund or unlock path** in the sender. Do not create another directory/journal to renew the allowance. If the journal has not been initialized, use the reviewed [live-test sequence](LIVE_TEST.md), not an automatic fallback. Count any earlier external declaration/funding attempts and their signed maxima/principal before proceeding. Those operations must be reserved and reconciled in this same journal by their approved sender. Their keys are never entered into this tool.

`send` requires interactive stdin and stderr. It displays the exact transaction hash, operation, sender, nonce, maximum fee, zero principal, Sepolia chain and complete transaction. Type **`SEND <exact displayed hash>`** to authorize that one submission. There is no `--yes`, background mode or automatic confirmation. A prior `SIGN` approval is not a `SEND` approval. The tool checks chain/class/public key/nonce before the prompt and again after confirmation. The fixed ledger then durably reserves the exact hash, sender/nonce, maximum fee and zero principal **before the one add-transaction RPC**. A duplicate hash or sender/nonce is refused even if the earlier result was uncertain.

The signed input and artifact must be private ordinary files owned by the operator, not symlinks; the artifact has mode `0600`. The journal directory is mode `0700`, its fixed filename is `kms-sepolia-budget.json`, and the sender checks its fixed run identity/caps through `live-budget.ts`. A stale `.lock`, malformed journal, exhausted cap, or existing evidence-file collision is a stop condition. Preserve the files and reconcile; do not delete them to retry.

## What is verified before send

The sender independently checks the strict signed-artifact schema, binds every transaction field to the original operator input, recomputes the transaction hash using all V3 fields, and verifies the four-limb canonical low-s secp256k1 signature against the pinned full public key. It rechecks the exact deployment key/class/salt/address commitment, or the single allowed Ping call. It computes the fee ceiling from all three resource bounds plus the L2 tip, enforces both the operator's bound and the fixed 5 STRK per-attempt fee cap, then reserves that exact maximum with zero principal.

The generated RPC payload uses precisely those checked fields. There is one HTTP add-transaction request, no SDK retry machinery and no resend loop. Responses are bounded while streaming, raw provider errors are discarded, and redirect following is disabled. Accepted-block preflight and receipts depend on the selected trusted RPC; they are not independent consensus proof or a guarantee about pending transactions. Keep other writers of the administrator nonce stopped.

## Receipt and uncertainty handling

Before the network request, the tool writes and fsyncs an exclusive private `kms-submit-<transaction-hash>.jsonl` evidence file alongside the journal. It preserves the expected hash, exact reservation and attempt index, then appends/fsyncs the returned public hash or a fixed ambiguity reason. A returned hash must match the recomputed signed hash. A timeout, rejected/malformed response, mismatched hash or missing receipt keeps the whole reservation; none permits an automatic resend.

After a matching RPC response, the tool makes one receipt lookup. To confirm, the receipt must match the expected hash/type, report accepted finality and success/revert, use `FRI`, and stay within the reserved fee. Deployment receipts must name the pinned account. The tool fetches the **canonical block by receipt block number**, compares its hash/status and checks transaction inclusion before marking the original attempt confirmed. Successful and reverted receipts both retain the entire attempt and signed maximum; actual fees are recorded without granting more budget.

The CLI prints only a fixed status: `SUBMIT_CONFIRMED_SUCCESS`, `SUBMIT_CONFIRMED_REVERT`, `SUBMIT_PENDING`, `SUBMIT_AMBIGUOUS` or `SUBMIT_OPERATION_FAILED`. Only confirmed success exits zero. A nonzero exit is **not permission to rerun `send`**: the reservation may already exist and the transaction may already be accepted. The evidence file and original hash are the continuation point. RPC transport failures, invalid/over-limit receipts and canonical-block mismatch do not release the debit.

Use read-only reconciliation for the original signed artifact:

```sh
"$KAMUI_BUN" submit.ts reconcile --input /absolute/private/operator-input.json \
  --signed /absolute/private/operator-signed.json \
  --journal "$KAMUI_KMS_LIVE_JOURNAL"
"$KAMUI_BUN" live-budget.ts inspect --journal "$KAMUI_KMS_LIVE_JOURNAL"
```

`reconcile` verifies the same artifact and exact existing reservation, checks Sepolia and queries the original receipt/canonical block. It performs no add-transaction RPC and needs no KMS access or interactive approval. Changed or conflicting receipt observations are refused by the journal. If an earlier submission returned a different hash, preserve that evidence and investigate both public transaction references independently; this helper follows the original expected hash and never treats an unrelated receipt as success.

A crash can leave a consumed reservation and only partial evidence, including a failure **before** an actual send. The tool deliberately cannot infer that a network send never happened from missing output. Do not clear that reservation. If evidence persistence fails after the network request, use the original signed hash for read-only investigation. Filesystem tampering, copying/resetting the ledger or a different sender bypassing this tool are outside this local enforcement boundary.

## Local verification

The 27 focused submission tests use only mocked RPC/HTTP and ephemeral synthetic keys. They cover exact payload/hash/signature/fee binding, deploy and Ping acceptance, durable reservation before send, query/registry rejection, replay, fee/attempt/aggregate caps, rejection and state changes during approval, timeouts/hash mismatch/malformed/pending receipt continuation, accepted reverts, evidence-write failure, canonical-block mismatch and the actual HTTP-transport path for undeployed-account errors. These are local checks, not live KMS or sequencer acceptance.

```sh
"$KAMUI_BUN" test submit.test.ts
./node_modules/.bin/tsc --noEmit
```
