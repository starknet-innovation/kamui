# Recovery jobs after an API restart

The running API uses SQLite for recovery metadata. `RECOVERY_DB` overrides its path; by default `recovery.sqlite` is beside `REGISTRY_DB`, so the existing `/data` deployment volume also persists it. Keep the file and its backups private. The database is mode 0600, uses `synchronous=FULL`, and follows `REGISTRY_JOURNAL_MODE` (`DELETE` by default; no WAL on a network volume). The database is bound to the configured chain ID and account class and refuses a different binding.

Exactly one API process may execute jobs against this database. The relayer mutex is process-local and keyed by the shared account instance; other processes or account instances using the same relayer key still need separate nonce coordination. Deployment must stop the old process before starting the new one. This is not a distributed queue or a database-failover design.

## What is durable

The database holds a SHA-256 hash of the random polling capability, a request fingerprint, the account address, terminal result/error, and any paid transaction's hash, sender and nonce. It does **not** hold the raw capability, JWT, pepper, blinding, device signature, proof or signed transaction. Authenticated deployment token/pepper and submitted proof inputs remain only in API process memory while their job runs. Execution/proving witnesses remain in browser memory; they are never backend jobs.

Before broadcasting a deployment or recovery, the API asks starknet.js to prepare/sign the transaction in memory. It computes the deterministic transaction hash, including proof facts, from that wire payload and commits the intent to SQLite **before** sending it. If that commit fails, nothing is broadcast. The node's returned hash must match. The shared relayer lock covers preparation, intent journaling and broadcasting; the other local relayer routes use the same lock.

A completed result survives restart and can still be polled with the original capability. Both `/relay` and `/deploy/authenticated` reserve durable jobs and share the same per-account locks/status endpoint. Public server-proving `/recover` and unauthenticated `/deploy` are disabled. Identical submissions keep their original job; new jobs for an unresolved account are refused with `409 IN_PROGRESS`. Finished results expire after 30 minutes. Unresolved intents never expire automatically.

## Restart behavior

- **Before a paid send:** submitted JWT/deployment inputs or proof bytes are gone. The job becomes `failed / RECOVERY_INTERRUPTED` (409). Start a fresh sign-in; nothing is re-proven or broadcast from disk.
- **An authenticated deployment (`prepare`) intent was written:** the API checks that exact hash and restores a successful result after accepted success, so polling can continue to browser proving. A reverted transaction becomes `RECOVERY_REVERTED` (400). Historical combined server-proving jobs used `deploy` intents; those still become `RECOVERY_INTERRUPTED` after successful deployment because their proof inputs were not saved.
- **A recovery intent was written:** a receipt with successful execution and `ACCEPTED_ON_L2` or `ACCEPTED_ON_L1` finality restores the original successful result, including its hash. A reverted transaction becomes `RECOVERY_REVERTED`.
- **No accepted receipt yet (including `PRE_CONFIRMED` success or revert), an RPC error, or a crash between the intent commit and broadcast:** status stays `running`, with `phase: reconciling` and the public hash. The account lock stays held. The server does not sign, re-prove or rebroadcast another transaction.

Reconciliation runs at startup, every 15 seconds, and when the capability is polled. Receipt success is tied to the precomputed transaction hash; an untrusted claim of ownership is never used to manufacture a successful result. The client still verifies device ownership on chain after ordinary recovery. An override recovery transaction only queues its existing delayed procedure; this journal does not finalize it.

A current owner check or `transaction not found` alone cannot prove that an uncertain transaction will never land. This conservative policy can leave a pre-broadcast crash waiting indefinitely. It is deliberate: fresh paid work is blocked rather than risking duplicate or conflicting execution. Losing the SQLite database still loses these safeguards; volume durability and backup/restore need operator review.

## Resolve a transaction that was superseded

First inspect the recorded original hash on an independent trusted RPC/explorer. If it has a receipt, restore RPC access and let ordinary reconciliation finish. Never delete an active row to bypass the lock.

If a **different** transaction from the **same relayer sender and exact nonce** has become `ACCEPTED_ON_L1`, that finalized transaction proves the original can no longer enter the canonical chain. **Stop the API before running the operator command, wait for it to exit, then restart the API.** The command cannot infer another process's in-memory activity. SQLite compare-and-set updates prevent late callbacks from replacing a terminal resolution or recording another paid intent, but do not replace the single-writer operating rule. The operator can record the finalized replacement with:

```sh
bun run src/scripts/reconcile-recovery.ts <original-tx-hash> <finalized-replacement-tx-hash>
```

The command reads no signing key and submits no transaction. It verifies the finalized replacement's sender and nonce against the durable intent, then marks the original job `RECOVERY_SUPERSEDED` (409), releasing the account for a fresh sign-in. It refuses an L2-only receipt, another nonce/sender, the same hash, or changed intent. It accepts only public transaction hashes as arguments. Do not invent a replacement or sign a new transaction merely to clear a row without an operator review of the original's status.

## Verification and limits

Tests abruptly exit a child process during work and after an intent commit, reopen SQLite, reconcile successful and reverted receipts, retain locks through missing/unavailable receipts, check terminal retention and retry deduplication, enforce finalized replacement resolution, inspect the database for secret sentinels, and check restrictive permissions. A public Sepolia run-9 invoke fixture independently anchors the V3 hash calculation; another test verifies a real SDK signer signature with proof-fact commitment and fails verification if facts are dropped.

This preserves status and safely reconciles already prepared transactions. It does not resume browser proof generation, survive loss/corruption of the database, provide multiple API writers, persist the sponsor ledger, or make a claim about production filesystem crash guarantees. Production key handling and storage policies still require their respective owners' review.
