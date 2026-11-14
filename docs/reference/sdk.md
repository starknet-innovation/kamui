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
| `replaced` | The same session key was registered again with another expiry. A renewal by this app reads this way to a watcher holding the connection from before it: see `renewedConnection` |
| `gone` | The account no longer has the session, and the cause was not seen |

### `checkSessionEnded(connection, provider, now?): Promise<SessionEnd | null>`

One look: `null` while the session is alive, else `{ reason }` with `expired` (decided locally), `replaced` or `gone`. For use after a failed call.

### `renewedConnection(connection, store): Connection | null`

After a `replaced`: the stored connection, if it is for the same account and session key with another deadline, which is what a renewal through `beginExtend` leaves in the store. `null` when the store holds nothing newer. See [Renewals and the watcher](/guide/sessions#renewals-and-the-watcher).

### `isSessionRefusal(error): boolean`

Whether an error carries the account's `Kamui: invalid session` refusal, as text or as the felt a node prints. The account gives it for an ended session, a call outside the scope and a nonce outside the session's range; follow it with `checkSessionEnded`. `false` proves nothing: a relayer may not pass the reason on, and a self-paid transaction is refused at validation without it.

### `sessionEventTracker(session)`, `SESSION_END_EVENT_KEYS`

For your own event source. `SESSION_END_EVENT_KEYS` is the `keys` filter for `starknet_getEvents` or `starknet_subscribeEvents` on the account's address. `sessionEventTracker({ publicKey, validUntil })` returns `{ push(event), ended }`: push the events in the order they were emitted and read `ended` (`null`, or the reason).

### `saveConnection(connection, store): boolean`

Writes `connection` over the stored one, only if the store still holds a connection with the same session key and deadline. For keeping `connection.session.nonces` across reloads when you do not pass `{ store }` to `sessionCall`.

### `forgetConnection(store): void`

Removes the connection and any pending request. Does not revoke the session on chain; the user does that from the keychain.

### `pendingRequestKind(store): 'connect' | 'execute' | 'signMessage' | null`

Which answer the app is waiting for. Call it before `finishConnect`/`finishExecute`/`finishSignMessage` to pick the right one.

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

## Signing messages

### `sessionSignTypedData(connection, typedData): string[]`

Signs SNIP-12 typed data with the session key, as the connected account: `[session_pubkey, r, s, valid_until]`. No prompt and no transaction. The account's `is_valid_signature` accepts it while the session exists and has not expired; the session's scope and limits do not apply to messages.

### `beginSignMessage({ keychainUrl, redirectUri, appName?, typedData }, store): string`

Stores the pending request (`kamui.pending.sign`) and returns the keychain URL that asks the user to sign `typedData` with their account's owner key. Needs no session. The typed data must be SNIP-12 revision 1 and its domain must name the account's network.

### `finishSignMessage(fragment, store): { account, chainId, signature } | null`

Reads the answer. `signature` is the owner's `[r, s]`. Throws if the user denied or the keychain reported an error.

### `verifyMessageSignature(provider, account, typedData, signature): Promise<boolean>`

Asks the account whether it accepts the signature for that message (`is_valid_signature`). Works for owner and session signatures. Run it on your server before trusting a sign-in.

### `typedDataHash(typedData, account): string`

The SNIP-12 message hash the account signs. It commits to the account address.

## Wallet interface

The helpers above, behind the interface wallet libraries expect. Walkthrough: [starknet-react](/examples/starknet-react).

### `new KamuiWallet({ keychainUrl, provider, session, sponsor?, store?, page? })`

A get-starknet-style wallet object (`id`, `name`, `version`, `icon`, `request`, `on`, `off`) for one session.

| Member | |
|---|---|
| `resume(): Promise<Connection \| null>` | Once per page load: reads the keychain's answer, loads the stored connection, checks it on chain. Never redirects, never throws. |
| `connect(): Promise<Connection>` | Settles at once with a live session. Otherwise navigates to the keychain and never settles. |
| `renew(): Promise<never>` | Navigates to the keychain to renew the session under the same key, with the `session` option's terms. `resume()` picks up the renewed session. Use it on `SESSION_EXHAUSTED`, or before the session expires. |
| `disconnect(): void` | Forgets the session key and emits `accountsChanged` with `[]`. |
| `execute(calls): Promise<{ transaction_hash }>` | Sends calls inside the session, sponsored if `sponsor` is set. Sponsored calls are sent one at a time; the place in the session's nonces is kept on the connection and in `store`. |
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

## Popup mode

The keychain's requests, in a popup, without leaving the page. See [Popup mode](/guide/popup).

### `connectWithPopup(options, store, popup?): Promise<Connection>`

Opens the keychain's `/connect` page in a popup and resolves with the connection, which is also stored (`kamui.connection`). `options` are those of `beginConnect`. The pending request stays in memory. Must be called synchronously from a user action.

### `executeWithPopup({ keychainUrl, redirectUri, appName?, calls }, store, popup?): Promise<{ transactionHash }>`

The same for one approved transaction.

### `signMessageWithPopup({ keychainUrl, redirectUri, appName?, typedData }, store, popup?): Promise<{ account, chainId, signature }>`

The same for one owner-signed message. Verify the signature as after `finishSignMessage`.

### `relayPopupResult(): boolean`

Call first on the page `redirectUri` names. Returns `true` when the page is the end of a popup request: it has relayed the answer and is closing. Returns `false` otherwise.

### `PopupOptions`

| Option | Default | Meaning |
|---|---|---|
| `timeoutMs` | 10 minutes | How long to wait for the answer |
| `signal` | none | An `AbortSignal`; aborting closes the popup and rejects with `aborted` |
| `fallback` | `'redirect'` | What a blocked popup does: `'redirect'` navigates as `beginConnect` would (the promise never settles), `'none'` rejects with `blocked` |
| `features` | `popup,width=480,height=720` | The `window.open` features. Never `noopener` or `noreferrer` |
| `pollMs`, `closedGraceMs` | 500, 1000 | How often a closed popup is looked for, and how long an answer is still awaited after one |

### `KeychainPopupError`

Thrown when a popup request ends without an answer. `code` is `'blocked'`, `'closed'`, `'timeout'` or `'aborted'`.

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
