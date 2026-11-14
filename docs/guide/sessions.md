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
