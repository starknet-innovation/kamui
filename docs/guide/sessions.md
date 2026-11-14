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
