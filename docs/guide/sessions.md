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

Sponsored transactions use a reserved range of nonces, one per call. The account keeps no counter of how many are used, so `sessionCall` finds a free one by asking the account:

- It remembers its place on the `connection` object. After the first call, each call costs two reads: the session's nonce base and the next nonce.
- With no memory (a fresh page load) it searches the range in about `2·log2(used)` reads: 18 for a session with 500 calls behind it, where it used to take 501.
- Pass the store and the place survives reloads too:

```ts
const prepared = await sessionCall(connection, calls, provider, { store: localStorage });
if (!prepared) {
  // every call is used: renew the session (below)
}
```

Prepare one call at a time per connection: two `sessionCall`s running at once get the same nonce, and the second transaction is refused. A call you prepared and never sent leaves its nonce free; `sessionCall` finds such leftovers once the rest of the range is used, at the cost of one read per nonce, once.

When the range is used up, `sessionCall` returns `null`.

## Renewing a session

`beginExtend` asks the user to renew the session your app already holds: more calls, a later deadline, the same key. It works like `beginConnect`, and the answer is read by `finishConnect`:

```ts
import { beginExtend, finishConnect } from '@kamui/sdk';

location.assign(
  beginExtend(
    connection,
    { keychainUrl, redirectUri: `${location.origin}/`, appName: 'My game', validUntil: nextWeek, maxCalls: 2000, calls, limits },
    localStorage,
  ),
);

// after the redirect back:
const renewed = finishConnect(location.hash, localStorage); // same session key, new limits
```

What to know:

- **It is one approval, and still a redirect.** The user sees the whole request again, marked as a renewal, and approves it once. No account change happens without them.
- **It replaces the session.** You state the full terms again (`calls`, `limits`, `validUntil`, `maxCalls`); nothing is carried over. The call count starts again from zero on both payment paths, and each spending limit starts a new period.
- **Calls signed before the renewal and not yet sent are refused after it.** Send what you have prepared, then renew.
- **Only the site the session was approved for can renew it.** The keychain refuses a renewal from an origin other than the one it recorded for the session, and warns the user when it has no record to check against.
- **If the user denies it,** `finishConnect` throws and the stored connection is unchanged: the old session works until it runs out.
- **It does not survive what ends a session.** After a revocation or a change of devices, renewing asks for a session under the old key, which is fine; you may as well `beginConnect`.

### Sizing a session

Each renewal costs the user a trip to the keychain, so ask for enough to make it rare, and no more than you would be comfortable having stolen with the session key:

- **`maxCalls`**: your expected number of sponsored transactions until `validUntil`, with headroom (two to three times). A large number costs nothing on chain: the range is reserved, not stored. It is shown to the user as is.
- **`validUntil`**: as long as a user would expect to stay signed in to your app on this device. Days to weeks for a game; hours for anything that moves value.
- **Spending limits** are what bound the damage, not `maxCalls`. Keep them tight and the other two generous.
- **Renew ahead of time**, at a moment that suits the user: when fewer than about 10% of the calls or of the time are left, and never in the middle of an action. `prepared.offset + 1` is how many calls are used when nonces are used in order; `connection.session.validUntil` is the deadline.

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

### Renewals and the watcher

A renewal registers the same key again with a new deadline, which is exactly what `replaced` reports. Two cases:

- **The page that renews.** `beginExtend` leaves the page, so its watcher goes with it. After the redirect, start a watcher on the connection `finishConnect` returns. It sees the renewal's own event as its session being set, not ended.
- **Another tab, or a long-running process, still holding the connection from before the renewal.** Its watcher reports `replaced`, correctly: signatures made with the old deadline are refused. Do not forget the stored session there. `renewedConnection` returns what the renewal stored; carry on with it:

```ts
import { forgetConnection, renewedConnection, watchSession } from '@kamui/sdk';

function watch(connection) {
  return watchSession(connection, provider, (end) => {
    const renewed = end.reason === 'replaced' ? renewedConnection(connection, localStorage) : null;
    if (renewed) {
      useConnection(renewed); // your app's state
      stop = watch(renewed);
      return;
    }
    forgetConnection(localStorage);
    // show "Connect with Kamui" again
  });
}
let stop = watch(connection);
```

A renewal that keeps the same `validUntil` is not reported at all: the old connection object keeps working, since `sessionCall` reads the session's nonce base on every call. Load the stored connection anyway to pick up the new `maxCalls`.

### When a call fails

A failed call does not say whether the session is over. Ask once, after the failure:

```ts
import { checkSessionEnded, isSessionRefusal } from '@kamui/sdk';

try {
  await sponsor(SPONSOR_URL, prepared.call);
} catch (error) {
  const end = await checkSessionEnded(connection, provider); // null, or { reason }
  if (end) {
    // 'expired', or 'gone' (revoked, or a device changed): connect again.
    // 'replaced': renewedConnection(connection, localStorage) if this app renewed it, else connect again
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
| `kamui.pending.sign` | The id of a sign-message request in flight |

- `localStorage` keeps the session across reloads and tabs. Any script running on your origin can read it, so it is only as safe as your page. The session's scope and limits cap the damage.
- `sessionStorage` forgets it when the tab closes. The user approves a new session in each tab.

## Signing messages

A session can sign SNIP-12 typed data as the account, for example to prove to your server who is playing. `sessionSignTypedData` returns the signature in the format the account accepts, with no prompt:

```ts
import { sessionSignTypedData, verifyMessageSignature } from '@kamui/sdk';

const signature = sessionSignTypedData(connection, typedData); // [session_pubkey, r, s, valid_until]

// on your server:
const ok = await verifyMessageSignature(provider, connection.account, typedData, signature);
```

The session's scope and limits do not apply to messages: while the session lasts it can sign any message. The signature stops verifying when the session expires, is revoked, or the user adds or removes a device. Put a nonce and an expiry in the message, and do not treat a session signature as the user's own consent to anything the session could not do.

Without a session, or when the user themself must sign (a sign-in), send them to the keychain with `beginSignMessage`. They see your origin, the domain and every value of the message, and sign with their account's owner key:

```ts
import { beginSignMessage, finishSignMessage, pendingRequestKind } from '@kamui/sdk';

location.assign(beginSignMessage({ keychainUrl, redirectUri: `${location.origin}/`, appName: 'My game', typedData }, localStorage));

// after the redirect back:
if (pendingRequestKind(localStorage) === 'signMessage') {
  const signed = finishSignMessage(location.hash, localStorage); // { account, chainId, signature } or throws if denied
}
```

The typed data must be SNIP-12 revision 1 with the account's `chainId` in its domain. The keychain never signs an outside execution as a message. Verify the answer with `verifyMessageSignature` before relying on it.

## Outside the session: one-off approvals

For a call the session does not cover, send the user to the keychain with `beginExecute`. They see every call, with token transfers and approvals described in plain words, and approve it with their account's full authority.

The keychain signs the transaction and **does not send it**. The user comes back with the signed transaction, read by `finishExecute`, and your app sends it through your [sponsor route](/guide/sponsorship#your-sponsor-route), like a session call:

```ts
import { beginExecute, finishExecute, pendingRequestKind, sponsor } from '@kamui/sdk';

location.assign(beginExecute({ keychainUrl, redirectUri: `${location.origin}/`, appName: 'My game', calls }, localStorage));

// after the redirect back:
if (pendingRequestKind(localStorage) === 'execute') {
  const approved = finishExecute(location.hash, localStorage); // { account, call } or throws if denied
  history.replaceState(null, '', location.pathname);           // before sending: a reload must not send it twice
  if (approved) {
    const transactionHash = await sponsor('/api/kamui/sponsor', approved.call);
  }
}
```

At most 10 calls and 100 calldata felts per call. A call to the user's own account is always refused.

- The approval is good for **10 minutes** and can be sent **once**, exactly as the user approved it. Send it as soon as the user is back.
- Your app's sponsorship budget pays for it. Kamui does not pay for one-off transactions on its own account, and the keychain holds no credential.
- The approved transaction is not bound by any session limit. Your sponsor route decides whether to pay for it, see [Sponsorship](/guide/sponsorship#your-sponsor-route).

::: warning Not yet confirmed on hosted Sepolia
This flow is covered by browser tests against a stand-in for the hosted backend's credential check. It has not been run against the hosted Sepolia backend yet. See [Status and limitations](/guide/limitations).
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
