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
    nonces?: { base: string; next: number; exhausted?: boolean }; // kept by sessionCall
  };
};
```

### `beginExtend(connection, options, store): string`

Like `beginConnect`, but for the session key `connection` already holds: the user is asked to renew that session instead of approving a new key. Same options, same answer, read by `finishConnect`. The stored connection is replaced only when the user approves. See [Renewing a session](/guide/sessions#renewing-a-session).

### `loadConnection(store): Connection | null`

The stored connection, without checking it on chain.

### `isConnectionAlive(connection, provider): Promise<boolean>`

Whether the session still exists on the account and has not expired. It ends on any change of devices.

### `forgetConnection(store): void`

Removes the connection and any pending request. Does not revoke the session on chain; the user does that from the keychain.

### `pendingRequestKind(store): 'connect' | 'execute' | null`

Which answer the app is waiting for. Call it before `finishConnect`/`finishExecute` to pick the right one.

## Sending

### `sessionCall(connection, calls, provider, options?): Promise<{ call, offset } | null>`

Signs `calls` with the session key as a sponsored outside execution and returns the `execute_from_outside_v2` call to hand to a relayer. Returns `null` when the session's `maxCalls` sponsored nonces are used.

It finds a free session nonce and records its place in `connection.session.nonces`, so later calls on the same object cost two reads. Options:

| Option | |
|---|---|
| `store` | The store the connection is kept in. The place is saved there as well, so it survives a reload. |
| `fromOffset` | Never use a nonce below this offset. A number in place of `options` means the same. |
| `scanGaps` | Default `true`: before answering `null`, read every nonce not read yet, in case one was skipped. `false` answers `null` as soon as the end of the range is found used. |

### `nextSessionNonce(reader, sessionPublicKey, maxCalls, fromOffset = 0, options?): Promise<{ nonce, offset } | null>`

The search `sessionCall` uses, for apps that build outside executions themselves. `options.hint` is the offset to try first; `options.scanGaps` and `options.concurrency` (default 8) control the last-resort scan. With `n` nonces used in order it reads the account about `2·log2(n)` times, once with a good hint. The nonce returned is always one the account reported unused.

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
