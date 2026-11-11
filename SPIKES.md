# Kamui spikes: findings

Run on 2026-11-11. Covers S1 to S4 from [PLAN.md](PLAN.md) section 5. Everything here is desk research on public repos and one public RPC call; nothing was deployed or proven.

Revisions read:

- `keep-starknet-strange/social-account` at `e168134`
- `OpenZeppelin/cairo-contracts` at tag `v4.0.1`
- `starknet-innovation/snip-36-prover-wasm` at `1b0d720`
- `starknet-io/SNIPs` PR 180 at head `ae0970c` (still an open draft, updated 2026-11-11)

## S4. Licences: done

| Repo | Licence | Consequence |
|---|---|---|
| `chipi-pay/sessions-smart-contract` | MIT | Usable as reference. It still implements the older SNIP-41 revision. |
| `avnu-labs/paymaster` | **GPL-3.0** | Running it unmodified as a service looks fine. Copying its code into Kamui's contracts, SDK or keychain would put that code under GPL. Treat it as a separate service behind its API and do not vendor it. |
| `starknet-innovation/snip-36-prover-wasm` | Apache-2.0 | Usable. Keep its `LICENSE` and `THIRD_PARTY_NOTICES.md` with the vendored files (social-account already does). |
| `OpenZeppelin/cairo-contracts` v4.0.1 | MIT | Confirmed at the pinned tag. |
| `keep-starknet-strange/social-account` | MIT | Confirmed. |

The GPL reading above needs legal review before SNF relies on it.

## S2. SNIP-36 on mainnet: live at protocol level, unproven for this flow

- Mainnet reports `starknet_version` 0.14.4 (block 17,799,986, read from a public RPC). Proof verification arrived in 0.14.2; 0.14.4 raised the provable size to 1.1B L2 gas.
- A third-party prover release (`snip-36-prover-backend` v1.4.1, 2026-11-10) reports end-to-end tests included on mainnet. This is the project's own claim, not checked here.
- Nothing in the social-login stack has run on mainnet. The browser prover's `SECURITY.md` says "There is no mainnet mode", and social-account marks its mainnet chain config as unverified.
- Prover operators must upgrade in the same window as each network upgrade, so Kamui's prover is tied to the protocol release schedule.

Still open: an official statement of mainnet SNIP-36 status, and a `prove_jwt` + `recover` run on mainnet.

## S3. OZ SRC9 fit: cannot be used as-is for sessions

OZ's `SRC9Component.execute_from_outside_v2` does this, in order: caller check, time window, read nonce, **write nonce**, then `is_valid_signature` on the account through the SRC6 dispatcher, then execute.

It conflicts with SNIP-41 on three points:

1. Signature validation goes through `is_valid_signature`, which is read-only and never sees the calls. The selector whitelist, admin blocklist and fee cap cannot be enforced there.
2. The nonce is written before the signature is checked. SNIP-41 requires recording after signature verification.
3. The component has no hook. Adding session accounting on top of its nonce write would mean two storage writes per sponsored session transaction, over the one-write budget.

Conclusion: write Kamui's own `execute_from_outside_v2`. The owner path keeps OZ's behaviour; the session path (4-element signature) checks whitelist, then signature, then records. Reusable from OZ without change: the `ISRC9_V2` interface and ID, the public SNIP-12 hashing in `snip12_utils`, and `execute_calls`. The bounded SNIP-9 nonce range (D6) fits well, because the nonce write that SNIP-9 already needs becomes the session's single write.

## S1. Proof time: first measurements in

Measured on 2026-11-11, one run each, Apple M3 Max with 36 GB, Sepolia. Details in [spikes/s1/results/RESULTS.md](spikes/s1/results/RESULTS.md).

| | Backend prover | Browser, memory build |
|---|---:|---:|
| Proof | 36.6 s | 183 s |
| Click to usable account (recovery) | about 47 s | 197 s |
| Peak memory | above 8 GB, up to 19.5 GB | 2.9 GB |

- The current backend prover image is OOM-killed at upstream's 8 GB cap. Upstream's "30 s and 4 GB" was for an older image.
- First login adds about 5 s for deployment.
- 47 s is above the plan's 30 s threshold for D4, on a best-case machine. This supports the owner set (option b).
- Three minutes in the browser on a top-end laptop confirms D9: backend proving by default.
- Backend proving at more than 8 GB per concurrent proof is a real cost and capacity item for Phase 2.

What the repos state (kept for comparison):

| Path | Time | Memory | Source |
|---|---|---|---|
| Backend Docker prover, `prove_jwt` | about 30 s | about 4 GB peak | social-account README |
| Browser, upstream build | "a few minutes" | about 14 GB wasm, suggested for 32 GB machines only | social-account README |
| Browser, memory build | "a few minutes", slower | about 3 GB wasm | social-account README |
| Browser, small demo transaction | 72 to 102 s on an M3 Max | 2.2 to 13.3 GB | prover-wasm README and port notes |

Other facts that shape the login flow:

- Browser proving needs desktop Chromium with wasm memory64. No mobile, no Safari or Firefox path is documented.
- The relay only accepts a proof whose base block is at least 10 blocks old, which adds a wait after proving.
- Each proof costs a flat 75M L2 gas and must decode to under 480,000 bytes.
- `PROOF_VALIDITY_BLOCKS = 1000` was sized for Sepolia's block time (about 1.7 s). It must be re-derived for mainnet.
- A first login needs a deployment and then a proof before the first transaction.

What this means for the plan:

- Backend proving is the only path that works for most users in v1. The backend then sees the JWT. It cannot redirect the recovery, since the nonce binds the new key, but it learns the user's identity. Add this to section 7.
- At about 30 s plus the 10-block wait, single-owner (D4 option a) sits right at the plan's threshold. A second device costing a fresh 30 s proof and invalidating the first device points towards the owner set (option b).

Measurement setup: ready in [spikes/s1](spikes/s1/README.md), no proof run yet. Upstream's Sepolia deployment can be reused (class declared, executor deployed, registry holds Google's current keys, public RPC serves storage proofs), so the run only needs a Google OAuth client, one funded Sepolia relayer account and one unfunded prover account.

## Smaller findings

- The committed `backend/.env` and `client/.env` hold only class hashes, contract addresses and an API URL. No key-named variables. (Plan Phase 2 step 1.)
- Declaring the account class costs "tens of STRK" because of the RSA code, and every address derives from the class hash. This strengthens the case for the frozen bootstrap class in D1.
- The SNIP-36 prover refuses the `RangeCheck96`, `AddMod` and `MulMod` builtins, so social-account carries its own RSA check in `jwt/rsa.cairo` instead of garaga's circuit. That file is custom cryptography and should be the first audit target.
- social-account's README names an open item: nothing watches `KeySet` events for a wrong key written to the registry. Add to D8.

## Sources

- https://github.com/keep-starknet-strange/social-account
- https://github.com/OpenZeppelin/cairo-contracts/tree/v4.0.1
- https://github.com/starknet-innovation/snip-36-prover-wasm
- https://github.com/starknet-innovation/snip-36-prover-backend/releases/tag/v1.4.1
- https://github.com/starknet-io/SNIPs/pull/180
- https://community.starknet.io/t/starknet-v0-14-4-prerelease-notes/116341
- https://community.starknet.io/t/0-14-2-pre-release-notes/116146
