# Kamui contracts

Cairo contracts for the Kamui account. Not audited. Do not deploy with real funds.

## What is here

| File | What it is |
|---|---|
| `src/kms_admin.cairo` | Separate immutable secp256k1 registry administrator for manual AWS KMS signing; local implementation, not deployed or audited. See [operator adapter and custody limits](../infra/aws/registry-admin/README.md). |
| `src/account.cairo` | `KamuiAccount`: social login and recovery, an owner set, session keys, outside execution. Deployed from `(aud, identity)` with no owner until the first recovery. Not upgradeable (plan D1). |
| `src/owners.cairo` | `OwnersComponent`: up to 5 owner keys, one per device (plan D4). |
| `src/core.cairo` | `KamuiCoreComponent`: `__validate__`, `__execute__`, `is_valid_signature` and Kamui's own SNIP-9 `execute_from_outside_v2`, for owner and session signatures. |
| `src/session/` | `SessionKeyComponent` and `SpendingPolicyComponent` (Part H), written from SNIP-41 (starknet-io/SNIPs PR 180 at `ae0970c`). The choices they make where the SNIP is open are listed at the top of `component.cairo` and `spending.cairo`. |
| `src/jwt/`, `src/social/` | From keep-starknet-strange/social-account (MIT). Unchanged except `social/component.cairo`, which reaches the account's keys through a `RecoveryTarget` trait instead of `get_public_key` and `set_public_key`. See `THIRD_PARTY.md`. |
| `src/mocks.cairo` | Test contracts, including `DevAccount`: the same core, owners and sessions with a first owner key set at deployment, for devnets. |

## Owners, recovery and sessions

- Any owner key signs for the account, with a plain `[r, s]` signature.
- A login on a new device (`recover`, or a finalized override) adds that device's key. Existing keys keep working.
- If the set is full (5 keys), a recovery replaces the oldest key, so a user who lost every device can still get back in. An owner adding a key by hand gets an error instead.
- An owner can remove a key, but not the last one.
- Every change of the owner set (a login on a new device, a key added or removed by an owner) revokes every session and drops any pending override recovery (plan D5). Sessions have to be approved again afterwards.
- Recovery proofs and new-owner signatures are bound to an anchor that changes with every change of the set, so a proof cannot be replayed to bring back a removed key.

## Revocations in the key registry

A recovery proof checks the login token against the registry as it stood at the proof's base block, and a proof stays usable for 1,000 blocks. So a revocation has to cut off proofs made before it:

- The registry records the block of its latest revocation. A revocation is a key removed, a recovery aud removed, or a key replaced with different material. Adding a new key, or writing the same key again, is not one.
- `recover` refuses any proof whose base block is not after that block (`REVOKED_SINCE_PROOF`). This applies to a normal recovery and to queuing an override.
- A pending override is still cancelled by any later revocation, as upstream does, and that now includes a key replacement.

The cost: one revocation cancels every proof in flight and every pending override, for all users. They sign in again. A proof based in the revocation's own block is refused too, whichever way the prover orders that block; that is deliberately strict.

These two changes answer findings 1 and 5 of a first security audit. They change the registry's interface, so **the account now needs a registry of this class**: upstream's registry on Sepolia does not have `last_revocation_block`, and `recover` against it would fail. The next live run needs a Kamui registry deployed, its address pinned in `JWK_REGISTRY_ADDRESS`, and the account class declared again.

## Spending policies

SNIP-41 Part H, as written. The owner can give a session a limit per token: a maximum per call and a maximum per time window, counted over `transfer`, `approve`, `increase_allowance` and `increaseAllowance`. Limits apply on both the self-paid and the sponsored path and share one window.

As the SNIP says, a token with no policy is unrestricted for the session. The contract does not force a policy to exist, so whoever approves a session (the keychain) must set one for every token the session may call.

## Build and test

The pinned tools (see `.tool-versions`) must come first on `PATH`:

```sh
export PATH="$(asdf where scarb 2.20.1)/bin:$(asdf where starknet-foundry 0.64.0)/bin:$PATH"
scarb build
snforge test
```

168 tests: 64 for sessions and outside execution, 31 for owners, recovery and registry revocations, 24 for spending policies, and upstream's 49 (20 in `tests/upstream_*.cairo` run against `KamuiAccount`, with four call sites adapted to the owner set and one test adapted to the revocation rule, and 29 unit tests in `src/jwt`).

## Devnet profile

`scripts/devnet-profile.ts` deploys `DevAccount` on a local devnet, sends real transactions through starknet.js, and counts the account's storage writes per transaction from the traces.

```sh
docker run --rm -p 127.0.0.1:5050:5050 shardlabs/starknet-devnet-rs:latest --seed 0
cd scripts && bun install && bun run devnet-profile.ts
```

Result on 2026-11-12, rerun after the owner set (devnet image built 2026-11-09):

| Transaction | Account storage writes | L2 gas |
|---|---:|---:|
| Owner: one call | 0 | 1,352,720 |
| Owner: add scoped session (1 entry) | 3 | 2,523,760 |
| Session, self-paid: first transaction | 1 | 1,280,960 |
| Session, self-paid: later transactions | 0 | 1,200,960 |
| Session, sponsored: each transaction | 1 | 2,139,280 |

This meets SNIP-41's storage budget: at most one write per session transaction, and none on the self-paid path after the first. The sponsored write is the SNIP-9 nonce, which any SNIP-9 account pays.

The L2 gas column is what the devnet reported. It did not change at all when the owner check went from one key to a loop over the owner set, so treat it as a rough figure, not as a measure of execution cost.

The sponsored transactions are signed over typed data built by starknet.js's own `outsideExecution.getTypedData`, so the message hash matches what standard tooling produces.

## Not done

- Pepper service (plan D2): upstream supports a pepper in `prove_jwt`; nothing here supplies one yet.
- A real measure of owner-transaction cost with 1 to 5 keys.
- On a live network: a recovery on a full owner set, and override recovery.

## Sepolia run

The registry revocation changes came after these runs, so the class below is no longer the current one, and the current one has not run on a live network.

On 2026-11-12 the class at commit `ac8e8a8` was declared on Sepolia (`0x13c5e8166199db99e894da9e55ce642267e5258c42eae8851357747b6201fdc`) and run end to end with a real proof: a login, an owner adding and removing a key, an owner-approved session with a spending policy, and sponsored and self-paid session transactions, with the refusals checked. An earlier class (commit `f067f32`, before the spending policy) was run the same way with two logins. Results are in `../spikes/s1/results/RESULTS.md` (runs 3 and 4).

For anyone building on these contracts: estimate the fee of a session transaction with validation on (`skipValidate: false` in starknet.js). The default estimate runs without the session signature, misses the session and spending checks, and comes out too low. Scripts: `scripts/declare-sepolia.ts`, `scripts/sepolia-check.ts`, `scripts/sepolia-session.ts`.
