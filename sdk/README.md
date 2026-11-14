# Kamui SDK

TypeScript helpers for Kamui accounts, on starknet.js 10: where an account lives, its owner keys, sessions with scopes and spending limits, and sponsored calls.

It covers the login (from a Google or Apple sign-in to a device key that owns the account) and what happens once a user has an account. Storing the login attempt across the redirect, and the redirect itself, are left to the caller (the keychain).

Not audited, like the contracts. It builds as the npm package `@kamui/sdk` (ESM and type declarations, `starknet` as a peer dependency); see [Package](#package). Code in this repository imports `src/` directly.

## What is in it

| Module | What it does |
|---|---|
| `keychain` | The keychain protocol and the app side of it: `beginConnect` and `finishConnect` for a session, `beginExecute` and `finishExecute` for one approved transaction, `sessionCall`, `sponsor`; and for the keychain `parseConnectRequest`, `parseExecuteRequest`, `sessionProblems`, `executeProblems`, `describeCall`. |
| `login` | `beginLogin`, `authUrl`, `parseLoginRedirect`, `fetchPepper`, `pepperFromFile`, `completeLogin`: the login flow, with the pepper service's key proof. |
| `client-proving` | `browserRecoverBackend`, `ClientProver`, V2 facts/profile helpers: local proof orchestration, authenticated first deployment and durable relay polling. |
| `address` | `identity`, `accountAddress`, `accountAddressFromLogin`, `deployAccountCall`: the account a login maps to. |
| `registry` | The session registry's client: `registryMessageHash`, `registryContentHash`, `signRegistryRequest`, `registryClient` (`put`, `list`, `remove`, with an injectable `fetch`) and `parseRegistryList`. The registry lets the keychain list an account's sessions; it is not an authority on them. |
| `reader` | `KamuiReader`: owners, anchor, session epoch, session data and scope, spending policies, nonces. |
| `owners` | `signNewOwner`, `addOwnerCall`, `removeOwnerCall`. |
| `pepper` | `exportPepper`, `parsePepperFile`, `pepperFileMatchesLogin`: a recovery file holding the user's pepper. |
| `sessions` | `createSessionCalls`, `addSessionCall`, `setSpendingPolicyCall`, `revokeSessionCall`, `revokeAllSessionsCall`, `sessionSignature`, and the checks `assertValidSession` and `unlimitedTokenCalls`. |
| `tokens` | `readTokenInfo`, `formatTokenAmount`, `describeAmount`: a token's name and exact amounts for approval screens, with known, unverified and unknown tokens told apart. |
| `outside` | Sponsored calls: `ownerOutsideExecution`, `sessionOutsideExecution`, `nextSessionNonce`. |
| `watch` | `watchSession`: tells an app once when its session ends (expiry timer, and the account's `SessionKeyRevoked` / `AllSessionsRevoked` / `SessionKeySet` events, polled or pushed over a WebSocket), with the reason. `checkSessionEnded` and `isSessionRefusal` for a failed call; `sessionEventTracker` and `SESSION_END_EVENT_KEYS` for your own event source. |
| `sessionAccount` | `createSessionAccount`: a starknet.js `Account` that signs as a session, for self-paid transactions. |

## Client-side login proving

`completeLogin` still skips recovery when the device already owns the account. For a new device, supply `browserRecoverBackend` with a local `ClientProver` implementation; the keychain adapter is `../keychain/src/proving.ts`. It uses the pinned `snip-36-prover-wasm` v1.0.1 V2 runtime in Workers, without a server fallback.

The browser backend authenticates `/deploy/authenticated` only when an account needs deployment, then sends completed proof/facts and ownership authorization to `/relay`. Both submissions have independent random job capabilities and poll `/recover/status`. Existing-account recovery sends no JWT or pepper to the API. Ordinary pepper lookup still sends the token to the pepper service, and first deployment sends it to the API for verification. The older `httpRecoverBackend` default `/recover` path is historical; the public API rejects server proving. See [CLIENT_PROVING.md](../keychain/CLIENT_PROVING.md) for installation, browser limits and live Kamui run 11 evidence.

## Using it

An owner approves a session for a game, limited to one contract and to 150 tokens an hour, and a relayer pays:

```ts
import {
  KamuiReader, createSessionCalls, newKeyPair, nextSessionNonce,
  ownerOutsideExecution, sessionOutsideExecution,
} from '@kamui/sdk';

const reader = new KamuiReader(provider, account);
const session = { ...newKeyPair(), validUntil: Math.floor(Date.now() / 1000) + 3600 };

// 1. The owner's device signs the approval. Anyone can submit it.
const approve = createSessionCalls(
  account,
  {
    sessionPublicKey: session.publicKey,
    validUntil: session.validUntil,
    maxCalls: 100,
    maxFeePerTx: 0n, // sponsored only
    scope: { kind: 'contracts', calls: [
      { to: game, entrypoint: 'move' },
      { to: token, entrypoint: 'transfer' },
    ] },
  },
  [{ token, maxPerCall: 100n, maxPerWindow: 150n, windowSeconds: 3600 }],
);
await relayer.execute(ownerOutsideExecution({
  chainId, account, calls: approve, ownerPrivateKey, window: { executeBefore: session.validUntil },
}));

// 2. The session signs calls. The nonce must be one of the session's own.
const next = await nextSessionNonce(reader, session.publicKey, 100);
await relayer.execute(sessionOutsideExecution({
  chainId, account, session, nonce: next.nonce,
  calls: [{ contractAddress: game, entrypoint: 'move', calldata: ['0x1'] }],
}));
```

The HTTP `sponsor` helper still calls Kamui's `/sponsor` gateway. The backend may route it to its development relayer or an optional separate AVNU paymaster; no key or paymaster credential is added to the browser. AVNU mode is Sepolia-only and has not been tested live. Its `PAYMASTER_SUBMISSION_UNCERTAIN` error means a transaction may already have been sent: check the chain before requesting another signed call. Backend configuration and fee-control limitations are in `../services/backend/PAYMASTER.md`.

A session that pays its own fees uses `createSessionAccount(...)` and then `execute` as with any starknet.js account. It needs `maxFeePerTx` above zero.

## Logging in

```ts
import { beginLogin, authUrl, parseLoginRedirect, fetchPepper, completeLogin, httpRecoverBackend, newKeyPair } from '@kamui/sdk';

// Before the redirect: keep `device` and `attempt` (the attempt holds no secret key).
const device = newKeyPair();
const attempt = beginLogin('google', device.publicKey);
location.assign(authUrl(attempt, googleClientId, redirectUri));

// After the redirect.
const answer = parseLoginRedirect(location.hash, attempt);
const pepper = await fetchPepper({ serviceUrl, idToken: answer.idToken, attempt, device });
const login = await completeLogin({
  provider, chainId, classHash, backend: httpRecoverBackend(apiUrl),
  idToken: answer.idToken, attempt, device, pepper,
});
// login.status is 'already-owner' (nothing was sent) or 'added' (a proof was made).
```

- A device that already owns the account costs two reads and no proof.
- A new device, or a first login, costs a proof: the backend deploys the account if needed, proves the token and submits `recover`. Expect tens of seconds. `httpRecoverBackend` submits a job and polls its status every two seconds. Each HTTP request has a 15-second deadline, with a 20-minute overall polling deadline. Transient connection failures are retried; a lost submission uses the same random job ID, so it does not start another job. Optional third-argument polling settings are `pollIntervalMs`, `requestTimeoutMs` and `timeoutMs`.
- Job IDs stay in client memory and go only in POST bodies. Reloading the page does not resume polling. The backend persists results and transaction intents across an API restart, but interrupted proof work needs a fresh sign-in. An uncertain submission stays locked while the backend checks its exact transaction hash; it is never automatically re-sent. A timeout or expired/missing job may follow an on-chain success; check ownership before signing in again. The SDK never automatically resubmits once polling has started. Deploy this SDK with the job-based backend; it does not use the old synchronous recovery protocol.
- **Adding a device revokes every session on the account.** Warn the user before a login on a new device.
- If the account already has five owner keys, the oldest is replaced.
- The id_token's signature is not checked on the client. The pepper service, the backend and the contract each check it.
- Pepper 0 is refused on mainnet.
- The recover request carries the key proof, so the backend can confirm the pepper with the pepper service before it pays for a deployment or a proof.

## Rules the SDK enforces for you

- **Spending limits.** Under SNIP-41 a token with no spending policy is unrestricted for a session. `createSessionCalls` therefore refuses a scope that includes `transfer`, `approve` or an allowance increase on a token with no limit, unless you pass `allowUnlimitedSpending`. The contract does not enforce this; the SDK does.
- **Fee estimation.** `SessionAccount` always estimates with validation on. The default starknet.js estimate runs without the session signature, misses the session and spending checks, and comes out too low: a transaction ran out of gas that way on Sepolia. If you build session transactions without `SessionAccount`, pass `skipValidate: false` yourself.
- **Scopes the contract would never honour** (a blocked entry point such as `add_owner`, or the account itself as target) are rejected before anything is sent.

## Things to know

- **Any change of owners revokes every session**, including a login on a new device. Check `reader.session(key).exists` and ask the user to approve again.
- **Sponsored session nonces** are a reserved range of `maxCalls` values; any other nonce is refused. `nextSessionNonce` finds the next free one by asking the account, one call per used nonce, so keep the returned offset for long sessions.
- **`maxCalls` is counted per path**: a session may send up to `maxCalls` sponsored and up to `maxCalls` self-paid transactions. On the self-paid path the range also shrinks when other keys send transactions.
- **The address depends on the class hash.** Kamui accounts are not upgradeable, so a new class means new addresses. Keep every class hash you have deployed with.
- **The session registry is untrusted input.** `registryClient().list()` drops records that are not shaped as the protocol says and caps the list at 50, but what a record claims (the site, the calls, the limits) is only a claim. Check each session with `reader.session(key).exists`, read what it may do from the account, and show `origin` and `appName` as text.
- **`NO_PEPPER` is for testnets only.** Mainnet accounts need the pepper service.
- **Offer the pepper export.** The pepper service's key has no backup, so a user's exported pepper is their protection against its loss. The file reveals the user's account address to whoever holds it and gives no access to the account. Before using a file for a login, check it with `pepperFileMatchesLogin`, or take the pepper with `pepperFromFile`, which does. A file made for another account class is consistent with itself, so also pass `pepperFromFile` the class hash in use, or compare `file.classHash` yourself. Passphrase protection of the file is not implemented yet.

## Package

```sh
bun install
bun run build          # dist/: ESM and .d.ts, from src/ only
bun run test:package   # npm pack, then use the tarball from a scratch project
```

`test:package` (`scripts/check-package.mjs`) checks the tarball's file list, imports it under plain Node and Bun, and type-checks its declarations under `NodeNext` and `Bundler` resolution. It needs npm and the network.

Relative imports in `src/` carry a `.js` extension (`./utils.js`). That is what makes the built files load in plain Node; `tsconfig.build.json` rejects an import without it.

The package is not on npm yet, and `"private": true` stays in `package.json` until its name, scope and visibility are decided. Publishing is a manual run of the [sdk-package](../.github/workflows/sdk-package.yml) workflow; its header lists what has to be set up first. Until then, `npm pack` here gives an installable `kamui-sdk-<version>.tgz`.

## Tests

```sh
bun install
bun test test/unit.test.ts            # 19 tests, no network
bun test test/login.test.ts           # 24 tests, no network; runs the pepper service in process
bun test test/keychain.test.ts        # 23 tests, no network
bun test test/tokens.test.ts          # 9 tests, no network
bun test test/registry.test.ts        # 21 tests, no network

# needs Docker and the built contracts
docker run --rm -p 127.0.0.1:5050:5050 shardlabs/starknet-devnet-rs:latest --seed 0
(cd ../contracts && scarb build)
bun test test/devnet.test.ts          # 7 tests against the devnet
```

Bun 1.2 or later. The devnet tests deploy `DevAccount` (the production owner, session and spending code with a first key set at deployment) and the real `KamuiAccount` class for the address check. They are skipped when no devnet answers.

`examples/sepolia-smoke.ts` runs the same flow against an existing account on Sepolia. It passed on 2026-11-12 against the account from run 4 in `../spikes/s1/results/RESULTS.md`.

## Not here yet

- More than one live run. The login ran end to end on Sepolia once, through `../apps/login-demo` (`../spikes/s1/results/RESULTS.md`, run 5): a first login, a returning device and a new device.
- Browser proving (the backend proves; plan D9).
- A wallet-standard connector. Apps connect with the redirect helpers in `keychain`; see `../keychain/README.md` and `../apps/demo-dapp`.
- Override recovery calls.
- A release on npm. The package builds and is checked in CI; publishing it is a manual step that has not been taken.
