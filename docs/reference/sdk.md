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
  session: { privateKey: string; publicKey: string; validUntil: number; maxCalls: number };
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

## Native apps

For a native app that connects through a page on its own domain. See [Bounce page](/native/bounce-page).

### `beginNativeConnect(fragment, options, store): string | null`

Start page. Reads the app's state and handoff key from `location.hash`, stores them (`kamui.native.start`), creates the session key and returns the keychain URL, as `beginConnect` does. Returns `null` when the fragment holds no start request. `options` come from the page, never from the link.

### `finishNativeConnect(fragment, appLink, store): Promise<string | null>`

Return page. Reads the keychain's answer, seals it to the app's handoff key and returns the app link to navigate to. A refusal is sealed and handed off too. Clears the page's storage. Throws when `appLink` is not `https:`.

### `newNativeHandoff(): Promise<NativeHandoffSecret>`

App side. A fresh `{ state, publicKey, privateKey }` for one connect.

### `nativeStartUrl(startPage, secret): string`

App side. The start page URL to open in the system browser.

### `openNativeHandoff(link, secret): Promise<Connection | null>`

App side. Opens the app link. Returns `null` when the link holds no handoff; throws when it is for another state or key, or reports a refusal. Check the result with `isConnectionAlive` before using it.

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
