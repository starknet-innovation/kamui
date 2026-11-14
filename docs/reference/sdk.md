# SDK reference (app side)

The functions an app uses, from `@kamui/sdk` ([`sdk/src/keychain.ts`](https://github.com/starknet-innovation/kamui/blob/main/sdk/src/keychain.ts) and neighbours). The SDK also holds the keychain's own helpers (login, owners, registry, pepper); apps don't need those.

## Connecting

### `beginConnect(options, store): string`

Creates a session key pair, stores the pending request in `store` (`kamui.pending`), and returns the keychain URL to navigate to. Options: see [Sessions](/guide/sessions#what-you-ask-for).

### `finishConnect(fragment, store): Connection | null`

Reads the keychain's answer from `location.hash`. Returns `null` when the fragment holds no answer. Throws when the user denied, the keychain reported an error, or the answer does not match the pending request. On success stores the connection (`kamui.connection`).

```ts
type Connection = {
  account: string;
  chainId: string;
  classHash: string;
  session: {
    privateKey: string;
    publicKey: string;
    validUntil: number;
    maxCalls: number;
    /** The scope that was asked for. Absent on a connection stored by an older SDK. */
    calls?: { to: string; entrypoint: string }[];
  };
};
```

### `loadConnection(store): Connection | null`

The stored connection, without checking it on chain.

### `isConnectionAlive(connection, provider): Promise<boolean>`

Whether the session still exists on the account and has not expired. It ends on any change of devices.

### `forgetConnection(store): void`

Removes the connection and any pending request. Does not revoke the session on chain; the user does that from the keychain.

### `pendingRequestKind(store): 'connect' | 'execute' | null`

Which answer the app is waiting for. Call it before `finishConnect`/`finishExecute` to pick the right one.

## Sending

### `sessionCall(connection, calls, provider, fromOffset = 0): Promise<{ call, offset } | null>`

Signs `calls` with the session key as a sponsored outside execution and returns the `execute_from_outside_v2` call to hand to a relayer. Finds the next unused session nonce from `fromOffset`. Returns `null` when the session's `maxCalls` sponsored nonces are used.

### `sponsor(url, call, send?): Promise<string>`

`POST {url}` with `{ account, calldata }` and returns `transaction_hash`. Throws `sponsor: CODE` on an error answer. `send` defaults to `fetch`; pass your own to add headers server-side.

### `createSessionAccount({ provider, address, sessionPrivateKey, validUntil }): SessionAccount`

A starknet.js `Account` that signs as the session and pays its own fees (needs `maxFeePerTx > 0`). Fee estimates always run validation.

## One-off approvals

### `beginExecute({ keychainUrl, redirectUri, appName?, calls }, store): string`

Stores the pending request (`kamui.pending.execute`) and returns the keychain URL that asks the user to approve `calls` with the account's full authority.

### `finishExecute(fragment, store): { transactionHash } | null`

Reads the answer. Throws if the user denied or the keychain reported an error.

## Wallet interface

The helpers above, behind the interface wallet libraries expect. Walkthrough: [starknet-react](/examples/starknet-react).

### `new KamuiWallet({ keychainUrl, provider, session, sponsor?, store?, page? })`

A get-starknet-style wallet object (`id`, `name`, `version`, `icon`, `request`, `on`, `off`) for one session.

| Member | |
|---|---|
| `resume(): Promise<Connection \| null>` | Once per page load: reads the keychain's answer, loads the stored connection, checks it on chain. Never redirects, never throws. |
| `connect(): Promise<Connection>` | Settles at once with a live session. Otherwise navigates to the keychain and never settles. |
| `disconnect(): void` | Forgets the session key and emits `accountsChanged` with `[]`. |
| `execute(calls): Promise<{ transaction_hash }>` | Sends calls inside the session, sponsored if `sponsor` is set. Sponsored calls are sent one at a time. |
| `approveInKeychain(calls, appName?): Promise<never>` | Navigates to the keychain's `/execute` page. |
| `account(provider?)` | A starknet.js account whose `execute` is the wallet's. |
| `request({ type, params })` | The wallet API. See the walkthrough for what is answered. |
| `connection`, `error`, `lastApproved` | The live session, why the last trip to the keychain failed, and the hash of a one-off transaction just approved. |

`page` replaces how the wallet reads the URL fragment and navigates (`fragment`, `clearFragment`, `redirectUri`, `navigate`); the default uses `window`. Tests pass their own.

### `KamuiWalletError`

`code` is `NOT_CONNECTED`, `OUT_OF_SCOPE` (with `calls`), `SESSION_EXHAUSTED`, `SESSION_EXPIRED` or `UNSUPPORTED`.

### `callsOutsideSession(connection, calls): Call[]`

The calls the session's stored scope does not cover. Empty when the connection has no stored scope.

### `injectKamuiWallet(wallet, target = globalThis)`

Sets `target.starknet_kamui`.

### `@kamui/sdk/starknet-react`

`new KamuiConnector(options | wallet)` is a starknet-react `Connector` over a `KamuiWallet` (`connector.wallet`). `useKamuiReconnect(connector)` completes the connection after a page load and returns `{ isResuming, error, lastApproved }`. Needs `@starknet-react/core` 5 and React 18, which the rest of the SDK does not.

## Reading an account

### `new KamuiReader(provider, account)`

| Method | Returns |
|---|---|
| `session(publicKey)` | `{ exists, validUntil, maxCalls, maxFeePerTx, … }` |
| `isSessionCallAllowed(publicKey, to, entrypoint)` | Whether the scope allows that call |
| `spendingPolicy(publicKey, token)` | The limit and what has been spent in the current window |
| `owners()` | The device keys that own the account |

## Tokens

### `readTokenInfo(provider, token)`, `formatTokenAmount(amount, decimals)`, `describeAmount(...)`

Name, symbol and exact amounts for display. STRK and ETH are recognised by address; anything else is reported as unverified.

## Constants

| Name | Value |
|---|---|
| `KEYCHAIN_PROTOCOL_VERSION` | `1` |
| `MAX_EXECUTE_CALLS` | `10` |
| `MAX_EXECUTE_CALLDATA` | `100` |
| `MAX_SESSION_SCOPE_ENTRIES` | `64` |
| `SPENDING_ENTRYPOINTS` | `transfer`, `approve`, `increase_allowance`, `increaseAllowance` |
