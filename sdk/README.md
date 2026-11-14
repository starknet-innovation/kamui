# Kamui SDK

TypeScript helpers for Kamui accounts, on starknet.js 10: where an account lives, its owner keys, sessions with scopes and spending limits, and sponsored calls.

It covers the login (from a Google or Apple sign-in to a device key that owns the account) and what happens once a user has an account. Storing the login attempt across the redirect, and the redirect itself, are left to the caller (the keychain).

Not audited, like the contracts. Source-only for now: import from `src/`.

## What is in it

| Module | What it does |
|---|---|
| `keychain` | The keychain protocol and the app side of it: `beginConnect` and `finishConnect` for a session, `beginExtend` to renew one, `beginExecute` and `finishExecute` for one approved transaction, `beginSignMessage` and `finishSignMessage` for one owner-signed message, `sessionCall`, `sponsor`; and for the keychain `parseConnectRequest`, `parseExecuteRequest`, `parseSignMessageRequest`, `sessionProblems`, `executeProblems`, `signMessageProblems`, `describeCall`. |
| `messages` | SNIP-12 typed data signed as the account: `sessionSignTypedData` (a session, `[session_pubkey, r, s, valid_until]`), `ownerSignTypedData` (`[r, s]`), `verifyMessageSignature` (the account's `is_valid_signature`), `typedDataHash`, `typedDataFields`. |
| `native` | Native apps through a bounce page on the app's own HTTPS domain: `beginNativeConnect` and `finishNativeConnect` for the page, `newNativeHandoff`, `nativeStartUrl` and `openNativeHandoff` for the app. The session key is made in the page and reaches the app sealed, over an https app link. Unit-tested; not run on devices. See `../docs/native/bounce-page.md`. |
| `popup` | The keychain's requests in a popup, so the app's page is not reloaded: `connectWithPopup`, `executeWithPopup`, `signMessageWithPopup` (promises, with a fallback to the redirect when the popup is blocked), `relayPopupResult` for the page the popup ends on, and `KeychainPopupError`. |
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
| `wallet` | `KamuiWallet`: the app side of `keychain` behind the get-starknet wallet-object interface (`request`, `on`, `off`). Resumes after the redirect, routes `execute` through `sessionCall` and refuses calls outside the session with a `KamuiWalletError`. |
| `starknet-react` | `KamuiConnector` and `useKamuiReconnect`, for `@starknet-react/core` 5. Not part of the main entry point: import `@kamui/sdk/starknet-react`. React and starknet-react are optional peers. |

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
- **Sponsored session nonces** are a reserved range of `maxCalls` values; any other nonce is refused. The account accepts them in any order and has no counter, so `nextSessionNonce` searches: about `2·log2(used)` reads, or one with a `hint`. `sessionCall` keeps the hint on the connection for you. When the range is used up, `beginExtend` asks the user to renew the session under the same key.
- **`maxCalls` is counted per path**: a session may send up to `maxCalls` sponsored and up to `maxCalls` self-paid transactions. On the self-paid path the range also shrinks when other keys send transactions.
- **The address depends on the class hash.** Kamui accounts are not upgradeable, so a new class means new addresses. Keep every class hash you have deployed with.
- **The session registry is untrusted input.** `registryClient().list()` drops records that are not shaped as the protocol says and caps the list at 50, but what a record claims (the site, the calls, the limits) is only a claim. Check each session with `reader.session(key).exists`, read what it may do from the account, and show `origin` and `appName` as text.
- **`NO_PEPPER` is for testnets only.** Mainnet accounts need the pepper service.
- **Offer the pepper export.** The pepper service's key has no backup, so a user's exported pepper is their protection against its loss. The file reveals the user's account address to whoever holds it and gives no access to the account. Before using a file for a login, check it with `pepperFileMatchesLogin`, or take the pepper with `pepperFromFile`, which does. A file made for another account class is consistent with itself, so also pass `pepperFromFile` the class hash in use, or compare `file.classHash` yourself. Passphrase protection of the file is not implemented yet.

## Tests

```sh
bun install
bun test test/unit.test.ts            # 19 tests, no network
bun test test/login.test.ts           # 24 tests, no network; runs the pepper service in process
bun test test/keychain.test.ts        # 33 tests, no network
bun test test/tokens.test.ts          # 9 tests, no network
bun test test/registry.test.ts        # 21 tests, no network
bun test test/native.test.ts          # 10 tests, no network
bun test test/vectors.test.ts         # 14 tests, no network; the published vectors match the SDK
bun test test/nonce.test.ts           # 16 tests, no network
bun test test/watch.test.ts           # 43 tests, no network
bun test test/wallet.test.ts          # 35 tests, no network

# needs Docker and the built contracts
docker run --rm -p 127.0.0.1:5050:5050 shardlabs/starknet-devnet-rs:latest --seed 0
(cd ../contracts && scarb build)
bun test test/devnet.test.ts          # 10 tests against the devnet
```

`test/vectors/session-signing.json` holds test vectors for session signing in other languages (`../docs/reference/session-signing.md`). Regenerate it with `bun run test/vectors/generate.ts` after a deliberate change to what the SDK signs; `test/vectors.test.ts` fails until it matches.

Bun 1.2 or later. The devnet tests deploy `DevAccount` (the production owner, session and spending code with a first key set at deployment) and the real `KamuiAccount` class for the address check. They are skipped when no devnet answers.

`examples/sepolia-smoke.ts` runs the same flow against an existing account on Sepolia. It passed on 2026-11-12 against the account from run 4 in `../spikes/s1/results/RESULTS.md`.

## Not here yet

- More than one live run. The login ran end to end on Sepolia once, through `../apps/login-demo` (`../spikes/s1/results/RESULTS.md`, run 5): a first login, a returning device and a new device.
- Browser proving (the backend proves; plan D9).
- A wallet-standard connector. Apps connect with the redirect helpers in `keychain`; see `../keychain/README.md` and `../apps/demo-dapp`.
- Override recovery calls.
- Publishing as a built package.
