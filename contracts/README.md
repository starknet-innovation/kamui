# Kamui contracts

Cairo contracts for the Kamui account. Not audited. Do not deploy with real funds.

## What is here

| File | What it is |
|---|---|
| `src/account.cairo` | `KamuiAccount`: social login and recovery, session keys, outside execution. Deployed from `(aud, identity)` with owner key 0 until the first recovery. |
| `src/core.cairo` | `KamuiCoreComponent`: `__validate__`, `__execute__`, `is_valid_signature` and Kamui's own SNIP-9 `execute_from_outside_v2`, for owner and session signatures. |
| `src/session/` | `SessionKeyComponent`, written from SNIP-41 (starknet-io/SNIPs PR 180 at `ae0970c`). The choices it makes where the SNIP is open are listed at the top of `component.cairo`. |
| `src/jwt/`, `src/social/` | Copied unchanged from keep-starknet-strange/social-account (MIT). See `THIRD_PARTY.md`. |
| `src/mocks.cairo` | Test contracts, including `DevAccount`: the same core and sessions with a plain owner key, for devnets. |

Every change of owner key goes through `set_public_key`, including `recover` and a finalized override. That function drops any pending override and revokes every session.

## Build and test

The pinned tools (see `.tool-versions`) must come first on `PATH`:

```sh
export PATH="$(asdf where scarb 2.20.1)/bin:$(asdf where starknet-foundry 0.64.0)/bin:$PATH"
scarb build
snforge test
```

119 tests: 65 for sessions and outside execution, 5 for recovery with sessions, and upstream's 49 (20 in `tests/upstream_*.cairo` run against `KamuiAccount`, 29 unit tests in `src/jwt`).

## Devnet profile

`scripts/devnet-profile.ts` deploys `DevAccount` on a local devnet, sends real transactions through starknet.js, and counts the account's storage writes per transaction from the traces.

```sh
docker run --rm -p 127.0.0.1:5050:5050 shardlabs/starknet-devnet-rs:latest --seed 0
cd scripts && bun install && bun run devnet-profile.ts
```

Result on 2026-11-12 (devnet image built 2026-11-09, gas price 1 gwei-equivalent in fri):

| Transaction | Account storage writes | L2 gas |
|---|---:|---:|
| Owner: one call | 0 | 1,352,720 |
| Owner: add scoped session (1 entry) | 3 | 2,523,760 |
| Session, self-paid: first transaction | 1 | 1,280,960 |
| Session, self-paid: later transactions | 0 | 1,200,960 |
| Session, sponsored: each transaction | 1 | 2,139,280 |

This meets SNIP-41's storage budget: at most one write per session transaction, and none on the self-paid path after the first. The sponsored write is the SNIP-9 nonce, which any SNIP-9 account pays.

The sponsored transactions are signed over typed data built by starknet.js's own `outsideExecution.getTypedData`, so the message hash matches what standard tooling produces.

## Not done

- Upgrade path (plan D1) and multi-device owner set (plan D4).
- Pepper (plan D2): upstream supports it in `prove_jwt`; nothing here supplies one.
- Spending policy (SNIP-41 Part H).
- A run of `prove_jwt` and `recover` for `KamuiAccount` on Sepolia with a real proof. Adding sessions changes the class, so it needs its own declaration.
