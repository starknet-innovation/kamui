# Kamui SDK

TypeScript helpers for Kamui accounts, on starknet.js 10: where an account lives, its owner keys, sessions with scopes and spending limits, and sponsored calls.

It covers the login (from a Google or Apple sign-in to a device key that owns the account) and what happens once a user has an account. Storing the login attempt across the redirect, and the redirect itself, are left to the caller (the keychain).

Not audited, like the contracts. Source-only for now: import from `src/`.

## What is in it

| Module | What it does |
|---|---|
| `keychain` | The keychain protocol and the app side of it: `beginConnect` and `finishConnect` for a session, `beginExecute` and `finishExecute` for one approved transaction, `sessionCall`, `sponsor`; and for the keychain `parseConnectRequest`, `parseExecuteRequest`, `sessionProblems`, `executeProblems`, `describeCall`. |
| `login` | `beginLogin`, `authUrl`, `parseLoginRedirect`, `fetchPepper`, `pepperFromFile`, `completeLogin`: the login flow, with the pepper service's key proof. |
| `address` | `identity`, `accountAddress`, `accountAddressFromLogin`, `deployAccountCall`: the account a login maps to. |
| `registry` | The session registry's client: `registryMessageHash`, `registryContentHash`, `signRegistryRequest`, `registryClient` (`put`, `list`, `remove`, with an injectable `fetch`) and `parseRegistryList`. The registry lets the keychain list an account's sessions; it is not an authority on them. |
| `reader` | `KamuiReader`: owners, anchor, session epoch, session data and scope, spending policies, nonces. |
| `owners` | `signNewOwner`, `addOwnerCall`, `removeOwnerCall`. |
| `pepper` | `exportPepper`, `parsePepperFile`, `pepperFileMatchesLogin`: a recovery file holding the user's pepper. |
| `sessions` | `createSessionCalls`, `addSessionCall`, `setSpendingPolicyCall`, `revokeSessionCall`, `revokeAllSessionsCall`, `sessionSignature`, and the checks `assertValidSession` and `unlimitedTokenCalls`. |
| `tokens` | `readTokenInfo`, `formatTokenAmount`, `describeAmount`: a token's name and exact amounts for approval screens, with known, unverified and unknown tokens told apart. |
| `outside` | Sponsored calls: `ownerOutsideExecution`, `sessionOutsideExecution`, `nextSessionNonce`. |
| `sessionAccount` | `createSessionAccount`: a starknet.js `Account` that signs as a session, for self-paid transactions. |

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
- A new device, or a first login, costs a proof: the backend deploys the account if needed, proves the token and submits `recover`. Expect tens of seconds.
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

## Tests

```sh
bun install
bun test test/unit.test.ts            # 19 tests, no network
bun test test/login.test.ts           # 19 tests, no network; runs the pepper service in process
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
- Publishing as a built package.
