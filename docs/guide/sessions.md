# Sessions

A session is a key your app generates and holds, which the user's account accepts for a limited set of calls until a deadline. The user approves it once in the keychain; after that your app signs calls with it and no prompt appears.

## What you ask for

```ts
type ConnectOptions = {
  keychainUrl: string;   // https://sepolia.kamui.page
  redirectUri: string;   // where the answer goes; its origin is what the user sees
  appName?: string;      // up to 60 characters, shown next to the origin
  validUntil: number;    // unix seconds
  maxCalls: number;      // sponsored transactions the session may send
  maxFeePerTx?: bigint;  // fee cap per self-paid transaction, in fri. 0 (default) = sponsored only
  calls: { to: string; entrypoint: string }[];  // the scope: contract + function pairs
  limits?: SpendingLimit[];                       // per-token spending limits
};

type SpendingLimit = {
  token: string;
  maxPerCall: bigint;     // in the token's smallest unit
  maxPerWindow: bigint;
  windowSeconds: number;
};
```

The keychain shows the user every contract and function, the expiry, the call and fee caps, and each spending limit with the token's name and exact amount. It also tells them the session can sign messages as their account while it lasts.

## Rules the keychain enforces

The keychain refuses these requests whatever the user clicks:

| Rule | Why |
|---|---|
| A `transfer`, `approve`, `increase_allowance` or `increaseAllowance` in scope needs a spending limit for that token. | Under SNIP-41, a token with no policy is unrestricted for a session. |
| No call to the user's account itself, and none of the blocked entry points (`upgrade`, session and owner management). | A site must never be able to change who controls the account. |
| The scope names at least one contract and at most 64 entries. | No wildcard sessions from apps. |
| `validUntil` is in the future, `maxCalls` is a positive integer. | |

## How many calls

`maxCalls` is counted separately on each payment path: a session may send up to `maxCalls` **sponsored** transactions and up to `maxCalls` **self-paid** ones.

Sponsored transactions use a reserved range of nonces, one per call. `sessionCall` finds the next unused one by asking the account, one read per used nonce. For long sessions, keep the `offset` it returns and pass it back:

```ts
let offset = 0;
const prepared = await sessionCall(connection, calls, provider, offset);
if (!prepared) throw new Error('session used up');
offset = prepared.offset + 1;
```

When the range is used up, `sessionCall` returns `null`. Ask the user to connect again.

## When a session ends

A session stops working when:

- it reaches `validUntil`;
- the user revokes it, or revokes all sessions, from the keychain's account page;
- **the user adds or removes a device.** Any change of owners revokes every session on the account, including signing in on a new phone or laptop.

Check before you rely on a stored session, and offer to reconnect when it is gone:

```ts
import { forgetConnection, isConnectionAlive } from '@kamui/sdk';

if (!(await isConnectionAlive(connection, provider))) {
  forgetConnection(localStorage);
  // show "Connect with Kamui" again
}
```

### Being told when it ends

You do not need to ask the account before every call. `watchSession` calls you once, when the session ends, and says why:

```ts
import { forgetConnection, watchSession } from '@kamui/sdk';

const stop = watchSession(connection, provider, (end) => {
  // end.reason: 'expired' | 'revoked' | 'all-revoked' | 'owners-changed' | 'replaced' | 'gone'
  forgetConnection(localStorage);
  // show "Connect with Kamui" again
});

// when the page or component goes away:
stop();
```

How it knows:

| Cause | How it is seen | `reason` |
|---|---|---|
| `validUntil` passed | A local timer. No network. | `expired` |
| The user revoked this session | The account's `SessionKeyRevoked` event, keyed by the session key | `revoked` |
| The user revoked all sessions | The account's `AllSessionsRevoked` event | `all-revoked` |
| The user added or removed a device | `AllSessionsRevoked` in a transaction that also emitted `OwnerAdded` or `OwnerRemoved` | `owners-changed` |
| The same key was approved again with another expiry | The account's `SessionKeySet` event | `replaced` |
| It ended before the watcher started | One read of the account at the start | `gone` (or `replaced`) |

By default the watcher reads the account's events every 30 seconds: one `starknet_blockNumber`, and one `starknet_getEvents` from the last block it saw when there is a new block. Change the cadence with `pollIntervalMs`. Read failures go to `onError` and are retried at the next interval.

If your node serves WebSocket subscriptions, pass a starknet.js `WebSocketChannel` and nothing is polled:

```ts
import { WebSocketChannel } from 'starknet';

const channel = new WebSocketChannel({ nodeUrl: 'wss://YOUR-SEPOLIA-RPC' });
await channel.waitForConnection();
const stop = watchSession(connection, provider, onEnded, { channel });
```

Good to know:

- The answer comes from the node you give it. Treat it as a hint for your interface: the account still decides on every call.
- Events are read up to the latest accepted block, so a revocation shows up one block plus one interval later at most.
- The expiry timer follows the device's clock; the account follows block time.
- Over a WebSocket, events emitted while the socket is down are not replayed. The next failed call tells you (below).
- A session that used all its `maxCalls` has not ended on the account. `sessionCall` returns `null` for it.

### When a call fails

A failed call does not say whether the session is over. Ask once, after the failure:

```ts
import { checkSessionEnded, isSessionRefusal } from '@kamui/sdk';

try {
  await sponsor(SPONSOR_URL, prepared.call);
} catch (error) {
  const end = await checkSessionEnded(connection, provider); // null, or { reason }
  if (end) {
    // 'expired', 'replaced', or 'gone' (revoked, or a device changed): connect again
  } else if (isSessionRefusal(error)) {
    // the account refused the call but the session is alive: out of scope, or a used nonce
  }
}
```

`checkSessionEnded` is local for an expired session and one read of the account otherwise. It cannot tell a revocation from a change of devices; `watchSession` can, because it sees the event.

### Watching the events yourself

An indexer or a backend can watch the same events without the SDK. They are emitted by the user's account, so filter on its address. The first key is the selector of the event name (`starknet_keccak`):

| Event | Keys after the selector | Data |
|---|---|---|
| `SessionKeyRevoked` | `session_key` | none |
| `AllSessionsRevoked` | none | `new_epoch` |
| `SessionKeySet` | `session_key` | `valid_until`, `max_calls`, `max_fee_per_tx`, `allowed_len`, `scoped`, `generation` |
| `OwnerAdded`, `OwnerRemoved` | `owner` | none |

`SESSION_END_EVENT_KEYS` is the ready-made `keys` filter, and `sessionEventTracker` turns a stream of these events into "alive" or a reason.

## Where the session key lives

`beginConnect` writes to the `KeyValueStore` you pass (`localStorage`, `sessionStorage` or your own):

| Key | Holds |
|---|---|
| `kamui.pending` | The request in flight and its session key pair, until the answer arrives |
| `kamui.connection` | The account, chain, class hash and session key pair |
| `kamui.pending.execute` | The id of a one-off transaction request in flight |

- `localStorage` keeps the session across reloads and tabs. Any script running on your origin can read it, so it is only as safe as your page. The session's scope and limits cap the damage.
- `sessionStorage` forgets it when the tab closes. The user approves a new session in each tab.

## Outside the session: one-off approvals

For a call the session does not cover, send the user to the keychain with `beginExecute`. They see every call, with token transfers and approvals described in plain words, and approve it with their account's full authority. They come back with the transaction hash, read by `finishExecute`.

```ts
import { beginExecute, finishExecute, pendingRequestKind } from '@kamui/sdk';

location.assign(beginExecute({ keychainUrl, redirectUri: `${location.origin}/`, appName: 'My game', calls }, localStorage));

// after the redirect back:
if (pendingRequestKind(localStorage) === 'execute') {
  const sent = finishExecute(location.hash, localStorage); // { transactionHash } or throws if denied
}
```

At most 10 calls and 100 calldata felts per call. A call to the user's own account is always refused.

::: danger Not working on hosted Sepolia
The keychain currently sends one-off transactions to the sponsor endpoint without any app credential, and the hosted backend requires one. Expect `APP_AUTH_REQUIRED` until this is fixed. See [Status and limitations](/guide/limitations).
:::

## Self-paid session transactions

A session with `maxFeePerTx` above zero can also pay its own fees from the account's STRK balance, with a regular starknet.js `Account`:

```ts
import { createSessionAccount } from '@kamui/sdk';

const account = createSessionAccount({
  provider,
  address: connection.account,
  sessionPrivateKey: connection.session.privateKey,
  validUntil: connection.session.validUntil,
});
await account.execute([{ contractAddress: GAME, entrypoint: 'move', calldata: ['0x1'] }]);
```

`SessionAccount` always estimates fees with validation on. If you build session transactions yourself, pass `skipValidate: false`: the default estimate skips the session checks and comes out too low.
