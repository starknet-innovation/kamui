> Live acceptance completed on 12 November 2026: [run 13](../../../spikes/s1/results/run-13-kms-admin.md). No registry roles were transferred. The user explicitly removed Sepolia STRK caps before any paid submission; the current private run journal is v2. Default v1 caps below remain available for bounded runs.

# KMS k1 / Sepolia live acceptance

Prepared 12 November 2026. **Not run.** The dedicated KMS key was subsequently created and its policy/public metadata verified during the explicitly authorized setup test; see [setup results](SETUP_VALIDATION-2026-11-12.json). This signing-and-Sepolia acceptance procedure remains unrun. AWS key setup is operator-run; see [key setup](KEY_SETUP.md). This plan does not change a key policy, grant contract roles or provision a host.

The user approved a **new** live test budget: at most **4 paid attempts**, at most **12 test STRK total**, at most **5 STRK maximum signed fee per paid attempt**, with **no automatic retries**. This is separate from the already consumed run-12 allowance. A failed or uncertain send consumes an attempt and retains its full maximum fee reservation until reconciled; an API/process restart or changed directory does not reset that test allowance. Funding transfers, paid declarations and failed on-chain transactions count as paid attempts. Their fees count toward the total. Select and record the exact required funding principal after fee estimation and before transfer; conservatively reserve principal plus all fee maxima within 12 STRK. Do not treat the fee ceiling as permission to transfer an arbitrary balance. If the envelope cannot cover the work, stop for revised authorization.

There is **no transaction sender in `live-check.ts`**. The operator tool prepares reviewed signed artifacts without broadcasting. The separate [bounded submitter](SUBMIT.md) now binds admin deployment/test Ping payloads to exact signed artifacts and durable reservations before a single paid RPC. Declaration and funding still use their approved operator sender with matching journal reservations. Signed artifacts and a journal alone do not constrain an unrelated sender. No developer signer is imported into this package.

## 1. One KMS signature, no Starknet transaction

After the operator creates the reviewed asymmetric key, the [key setup](KEY_SETUP.md) commands save private AWS CLI `GetPublicKey` metadata in `admin-public-key.json`. The metadata includes the immutable key reference and base64 public SPKI. Do not paste that file into chat or Git. No private signing key or AWS credentials belong in any tool input. Use the reviewed temporary AWS session through the SDK default credential chain.

First convert that existing metadata locally; there are **no AWS/RPC calls** in this conversion. From `infra/aws/registry-admin`, use Bun 1.4.4 with an operator-owned mode `0700` output directory:

```sh
KAMUI_BUN=/Users/adrienlacombe/ws/kamui/spikes/s1/tools/node_modules/.bin/bun
"$KAMUI_BUN" run live-prepare.ts --metadata /private/kamui/admin-public-key.json \
  --region eu-west-1 --output-directory /private/kamui/kms-config
```

The input must be an owned mode `0600` regular file, not a symlink. The tool validates k1 metadata, canonical base64/SPKI, curve point and Region/key-reference agreement. It writes exclusive `live-check.input.json` mode `0600`, with `region`, immutable `keyId` and uncompressed SEC1 `publicKey`, and prints only a fixed status. It never overwrites an existing input. Independently confirm that public key is the intended new account controller before assigning authority.

Then create a separate new operator-owned mode `0700` attempt directory and explicitly run the one-signature check:

```sh
"$KAMUI_BUN" run live-check.ts --input /private/kamui/kms-config/live-check.input.json \
  --output-directory /private/kamui/kms-live-attempt-1 --confirm-kms-sign
```

This makes one `GetPublicKey` request and at most one `Sign` request. It verifies the exact immutable key reference, `ECC_SECG_P256K1`, `SIGN_VERIFY`, `ECDSA_SHA_256`, canonical public SPKI and the independently pinned public key. It signs a fresh, domain-separated, field-bounded synthetic challenge using `DIGEST`, normalizes low-s and verifies the signature locally. It has no RPC URL or broadcast path, so it cannot submit a Starknet transaction or spend STRK. Normal AWS API charges may apply.

Before contacting AWS it writes and fsyncs exclusive `attempt.json`, then fsyncs the containing directory. Success writes exclusive `result.json` containing only the public challenge, public key and normalized signature. Neither artifact includes key identifiers, AWS account identifiers, credentials or raw errors. Stdout contains only fixed status/counts. On failure preserve the directory; do not automatically retry or interpret an absent result as proof that KMS did not sign. Reusing the directory is refused before another AWS request. This reservation limits one check directory; it is not an account-wide KMS spending limit. The operator must authorize a new attempt directory.

This proves live KMS response interoperability with the TypeScript verifier, not Starknet deployment, sequencer validation, contract authority or recovery from loss of KMS access.

## 2. Freeze artifacts and derive the account

Build with pinned Scarb 2.20.1 / Foundry 0.64.0. Review the exact `KmsK1Admin` Sierra and CASM artifacts, compute the Sierra class hash, and record artifact SHA-256 digests and compiler versions with the private run journal. Confirm the existing Kamui user-account class remains pinned; no user-account class/address change is part of this test.

Derive the administrator address from the reviewed **new admin class**, chosen salt, deployer zero and constructor limbs `[x.low,x.high,y.low,y.high]`. Check that operator input uses those exact coordinates, salt, class and address. This immutable account has no key replacement or social recovery. Confirm custody and separate recovery/governance before registry handoff.

Read-only Sepolia RPC must check class declaration and predicted-address state first. An existing class must match the reviewed artifact; an existing account must have the exact expected class and all public-coordinate limbs. A different class, key or unexpected nonce is a stop condition. A supplied class hash alone is not proof of matching deployed code.

The existing `services/backend/src/scripts/declare-account.ts` declares **KamuiAccount**, not this class; do not use it here. `KmsK1Signer` intentionally refuses declarations. Prepare a missing-class declaration through the separately authorized declaration signer without copying/entering a private key. Never replace `KAMUI_ACCOUNT_CLASS_HASH` in `deployments.env` with this administrator class.

## 3. Bounded paid acceptance, after key readiness

`live-budget.ts` defaults to run identity `kamui-kms-sepolia-2026-11-12-v1`, four attempts, 12 STRK total reserved principal/fees, and 5 STRK maximum fee each. Select **one permanent operator-owned mode `0700` directory outside Git**, keep the same path across every restart, and initialize its fixed filename once:

```sh
export KAMUI_KMS_LIVE_JOURNAL=/private/kamui/kms-sepolia-budget.json
"$KAMUI_BUN" run live-budget.ts init --journal "$KAMUI_KMS_LIVE_JOURNAL"
"$KAMUI_BUN" run live-budget.ts inspect --journal "$KAMUI_KMS_LIVE_JOURNAL"
```

Never delete, move, recreate or switch this journal to reset an allowance. Existing files, malformed state or changed caps are refused. There is no reset/refund/unlock action. A crash can leave the exclusive `.lock` file: stop, preserve evidence and have the operator prove no writer survives before manually handling a stale lock. No automatic lock clearing is implemented. Malicious local state deletion/copying is outside this operator journal's enforcement boundary.

For external declaration/funding submission, review its exact signed artifact and compute its maximum V3 fee from all three resource bounds plus L2 tip. Estimate with **`skipValidate: false`**, approve exact query/normal transaction data, and confirm actual Sepolia chain, sender, nonce, hash, fee and principal. Reserve those exact reviewed values (decimal FRI/nonce, hex public sender/hash):

```sh
"$KAMUI_BUN" run live-budget.ts reserve --journal "$KAMUI_KMS_LIVE_JOURNAL" \
  "$KAMUI_OPERATION" "$KAMUI_PUBLIC_SENDER" "$KAMUI_TX_NONCE_DECIMAL" \
  "$KAMUI_REVIEWED_TX_HASH" "$KAMUI_MAX_FEE_FRI_DECIMAL" \
  "$KAMUI_APPROVED_PRINCIPAL_FRI_DECIMAL" --confirm-exact-reservation
```

The journal supports `declare`, `fund`, `deploy`, `ping`; principal must be zero except a recorded positive funding transfer within the approved total. Reservations atomically replace/fsync the private journal under an exclusive lock **before broadcast**. A duplicate hash or sender/nonce is refused. Every attempt, principal and full maximum fee remains debited across restarts, success and revert. No receipt grants extra budget. This conservative reservation is not a bill estimate.

For admin deployment and Ping, use [submit.ts](SUBMIT.md): it computes and reserves the exact hash/fee/nonce automatically. Do not pre-reserve those two operations manually, which would correctly trigger replay rejection. Use manual `reserve` only for the external declaration/funding path.

**The external sender must compare its actual payload to the reserved hash, sender, nonce, maximum fee and principal and refuse a mismatch.** The journal does not itself validate signed artifacts, observe RPC receipts or submit transactions; it cannot constrain a sender that ignores it. Preserve the exact artifact with its reservation. Never resend because receipt polling timed out: query the original hash and sender nonce, keeping the reservation while uncertain.

After independently observing an accepted receipt, record the actual fee/block:

```sh
"$KAMUI_BUN" run live-budget.ts reconcile --journal "$KAMUI_KMS_LIVE_JOURNAL" \
  "$KAMUI_REVIEWED_TX_HASH" confirmed-success \
  "$KAMUI_RECEIPT_ACTUAL_FEE_FRI_DECIMAL" "$KAMUI_RECEIPT_BLOCK_DECIMAL"
```

Use `confirmed-revert` for an accepted revert. Reconciliation is idempotent only for identical observations; unknown/conflicting hashes or fees above the reserved bound are refused. Nothing is refunded. Uncertain/rejected/not-found submissions remain reserved; do not infer that they never reached a sequencer. This document does not itself cause a signature or paid send.

An initial sequence can require all four attempts:

1. Declare the new class **only if missing**, then verify an accepted successful receipt and exact class hash.
2. Transfer the recorded minimum required test STRK principal within the approved total **only if needed**, counting its attempt and fee too. Reserve principal plus fee under the aggregate budget and verify actual balance before proceeding. No amount is selected by this document.
3. Deploy with the exact constructor key/salt/class and reviewed fee bound. Verify accepted success, actual class, public-coordinate limbs and resulting nonce.
4. Send one harmless `ping()` to the existing test target, never a registry mutation. Confirm accepted success, expected counter change, actual fee, balance delta and nonce.

Use the operator tool's read-only preflight and exact-hash confirmation for deployment/invoke signing. A signed artifact is not a receipt. Use the [bounded submitter](SUBMIT.md) for admin deployment/Ping; it independently verifies signature/hash/fees and preserves every reviewed field exactly. Declaration/funding still require the approved external sender and exact matching reservations. If declaration or funding is unnecessary, leave the unused attempts unused.

The registry grant and later renounce are paid operations, **not hidden inside this four-step test**. They need separate authorization or a reviewed revision demonstrably fitting the remaining envelope. They must remain separate across independent controller verification. Hosting still needs operator/security review; a successful Sepolia test does not automatically authorize AWS permissions or resource changes.

## 4. Free negative checks and evidence

After deployment, use read-only `starknet_call` on `is_valid_signature` with the synthetic live result. The original digest/signature must return `VALID`; a changed digest must return zero; a public synthetic signature under a different key must return zero. These need no second KMS key and submit no paid transaction. The published local vector can supply the different-key negative case after confirming its public key differs.

Record whether query estimation with validation enabled actually succeeds: local Cairo tests do not prove sequencer validation limits. Retain KMS diagnostic result, artifact hashes, exact class/account/public key, accepted deploy/invoke receipts, negative-check results, nonce observations, actual fees, principal and reserved maxima. Reconcile every ambiguous submission and verify attempt/aggregate limits before declaring acceptance complete.

The explicit `init --user-authorized-sepolia` option initializes an uncapped v2 journal only for the user's recorded Sepolia authorization. It does not migrate, overwrite or reset an existing journal. Exact-hash/sender-nonce replay checks, pre-send durable reservations and receipt accounting still apply. The ordinary v1 initializer and deployment/Ping submitter retain their original fee limits.

`live-sepolia.ts` is the fixed 12 November one-run harness, not a general deployment tool. It uses the existing backend SecretSource internally for class declaration/funding and the separate KMS signer for native account estimates. Run it from `services/backend` with the repository Bun; commands are `preflight`, `init-budget`, `budget`, `estimate-declare`, `send-declare`, `receipt-declare`, `estimate-fund` (decimal `KAMUI_FUNDING_FRI`), `send-fund`, `receipt-fund`, `estimate-deploy`, `estimate-ping`, `verify`. Existing private outputs are exclusive and must be preserved. Native signing/submission still uses the operator/submit CLIs. Never rerun a send after reservation or uncertainty; reconcile the original hash. The completed run's directory and journal must not be reinitialized.

Git evidence must omit KMS references, AWS account identifiers, credentials/session details, raw AWS errors and raw transaction signatures. Public Starknet addresses, hashes and receipt summaries can be separately sanitized. Current evidence includes live role/profile/key setup and public-metadata/policy reads, plus local fake-KMS/synthetic-key signing tests. Real `kms:Sign` calls, native deploy/invoke validation and four successful paid Sepolia transactions are now recorded in run 13. No registry authority was transferred.
