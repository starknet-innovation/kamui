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

### `watchSession(connection, provider, onEnded, options?): () => void`

Calls `onEnded({ reason, transactionHash?, blockNumber? })` once when the session ends, then stops. Returns a function that stops it early. Expiry is a local timer; revocation and device changes come from the account's events, polled with `starknet_getEvents` or pushed over a WebSocket. See [Being told when it ends](/guide/sessions#being-told-when-it-ends).

| Option | Default | |
|---|---|---|
| `pollIntervalMs` | `30000` | Time between two reads of the account's events |
| `channel` | none | A starknet.js `WebSocketChannel`. Events are pushed and nothing is polled; falls back to polling if the subscription cannot be opened |
| `onError` | none | Called with a failed read. The watcher retries at the next interval |
| `now`, `timers` | system | Clock (unix seconds) and timers, for tests |

`reason` is one of:

| | |
|---|---|
| `expired` | `validUntil` passed |
| `revoked` | The user revoked this session |
| `all-revoked` | The user revoked every session |
| `owners-changed` | The user added or removed a device |
| `replaced` | The same session key was registered again with another expiry |
| `gone` | The account no longer has the session, and the cause was not seen |

### `checkSessionEnded(connection, provider, now?): Promise<SessionEnd | null>`

One look: `null` while the session is alive, else `{ reason }` with `expired` (decided locally), `replaced` or `gone`. For use after a failed call.

### `isSessionRefusal(error): boolean`

Whether an error carries the account's `Kamui: invalid session` refusal, as text or as the felt a node prints. The account gives it for an ended session, a call outside the scope and a nonce outside the session's range; follow it with `checkSessionEnded`. `false` proves nothing: a relayer may not pass the reason on, and a self-paid transaction is refused at validation without it.

### `sessionEventTracker(session)`, `SESSION_END_EVENT_KEYS`

For your own event source. `SESSION_END_EVENT_KEYS` is the `keys` filter for `starknet_getEvents` or `starknet_subscribeEvents` on the account's address. `sessionEventTracker({ publicKey, validUntil })` returns `{ push(event), ended }`: push the events in the order they were emitted and read `ended` (`null`, or the reason).

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
