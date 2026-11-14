# starknet-react

`KamuiConnector` puts a Kamui session behind [starknet-react](https://www.starknet-react.com/): `useAccount`, `useConnect`, `useDisconnect` and `useSendTransaction` work as they do with an extension wallet. Calls inside the session are signed in the browser and sent through your [sponsor route](/guide/sponsorship#your-sponsor-route) without a prompt.

The code on this page is type-checked against the SDK in CI. The full files are in [`docs/snippets/starknet-react`](https://github.com/starknet-innovation/kamui/tree/main/docs/snippets/starknet-react).

::: warning Versions
Written and tested against `@starknet-react/core` 5.0.3 with `starknet` 10.8.0. starknet-react 5 declares `starknet ^8` as its peer, so your package manager will warn about the pair; the hooks on this page are covered by the SDK's tests on 10.8.0, the rest of starknet-react is not.
:::

## Installation

Vendor the SDK as in the [Quickstart](/guide/quickstart#_1-add-the-sdk), and alias the connector's entry point next to the SDK's. The longer alias goes first:

```ts
// vite.config.ts
const sdk = (file: string) => fileURLToPath(new URL(`./vendor/kamui/sdk/src/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: '@kamui/sdk/starknet-react', replacement: sdk('starknet-react.ts') },
      { find: '@kamui/sdk', replacement: sdk('index.ts') },
    ],
    dedupe: ['starknet', 'react', '@starknet-react/core'],
  },
});
```

```sh
npm install starknet@10.8.0 @starknet-react/core@5.0.3 @starknet-react/chains@5.0.3
```

`@kamui/sdk` itself does not import React or starknet-react; only `@kamui/sdk/starknet-react` does.

## 1. Create the connector

One connector for the app, outside any component. It takes the keychain, a provider, how calls are paid for, and the [session](/guide/sessions#what-you-ask-for) to ask for.

<<< @/snippets/starknet-react/kamui.ts

| Option | |
|---|---|
| `keychainUrl` | The keychain to send the user to. |
| `provider` | Reads the account: is the session alive, which sponsored nonce is next. |
| `session` | What to ask for. A function is called when the user connects. |
| `sponsor` | A URL (your sponsor route) or `(call) => Promise<transactionHash>`. Leave it out for [self-paid](/guide/sessions#self-paid-session-transactions) session transactions. |
| `store` | Where the session key is kept. Defaults to `localStorage`. |

## 2. Add the providers

<<< @/snippets/starknet-react/Providers.tsx

### Why `useKamuiReconnect`

Connecting is a full-page redirect. `connect()` sends the user to the keychain and never returns to the code that called it; the page that finishes the connection is the one the keychain sends the user back to. `useKamuiReconnect(connector)` does that on every page load:

1. reads the keychain's answer from the URL fragment, if the user just came back, and removes it from the address bar;
2. loads the stored session and checks on chain that it is still alive;
3. connects the connector, without a redirect, if there is a live session.

It returns `isResuming`, the keychain's `error` if the user refused, and `lastApproved`, the hash of a [one-off transaction](#calls-outside-the-session) the user just approved. It never redirects by itself.

::: tip autoConnect
starknet-react's `autoConnect` is not enough: it remembers a connector only once `connect()` has returned, and the first Kamui connection never does. You can leave `autoConnect` on for your other connectors; reconnecting twice is harmless.
:::

In Next.js, mark the providers file `'use client'`. On the server the connector reports itself unavailable and does nothing.

## 3. Connect and send

<<< @/snippets/starknet-react/Game.tsx

`useAccount().account` is a starknet.js account for the session. Its `execute` takes the same path as `useSendTransaction`, so a `Contract` connected to it also sends sponsored session calls.

## What is refused

A session is not the whole account. The connector refuses, **before anything is signed or sent**, with a `KamuiWalletError` whose `code` says why:

| `code` | When | What to do |
|---|---|---|
| `OUT_OF_SCOPE` | A call is not one of the session's `calls`. `error.calls` lists them. | Ask for it in `session`, or [have it approved in the keychain](#calls-outside-the-session). |
| `SESSION_EXHAUSTED` | All `maxCalls` sponsored calls are used. | `disconnect()`, then connect again for a new session. |
| `SESSION_EXPIRED` | The session is past `validUntil`. | Same. |
| `NOT_CONNECTED` | There is no session. | Connect. |
| `UNSUPPORTED` | `useSignTypedData`, `useDeclareContract`, `useSwitchChain` to another chain, `useWatchAsset`. | A session cannot do these. |

The hooks surface it as their `error`. Limits the app cannot check ahead (a [spending limit](/guide/sessions#what-you-ask-for), a session revoked a moment ago) still come back from the sponsor route or the network, see [Errors](/reference/errors).

### Calls outside the session

`connector.wallet.approveInKeychain(calls, appName)` sends the user to the keychain to approve one transaction with the account's full authority. Like connecting, it leaves the page; `useKamuiReconnect` reports the transaction hash as `lastApproved` on the way back.

::: danger One-off approvals on hosted Sepolia
The keychain's `/execute` page currently fails on the hosted backend with `APP_AUTH_REQUIRED`. See [Status and limitations](/guide/limitations).
:::

## Without starknet-react

The connector is a thin wrapper around `KamuiWallet` from `@kamui/sdk`, which has the shape get-starknet calls a wallet object: `id`, `name`, `icon`, `request`, `on`, `off`. Use it directly with starknet.js's `WalletAccount`, or expose it as `window.starknet_kamui`:

<<< @/snippets/starknet-react/get-starknet.ts

It answers `wallet_getPermissions`, `wallet_requestAccounts` (with `silent_mode` it never redirects; without, it connects), `wallet_requestChainId`, `wallet_switchStarknetChain` (to the session's own chain only), `wallet_addInvokeTransaction` and `wallet_supportedWalletApi`. Everything else is refused with `UNSUPPORTED`.

::: warning Not a wallet-standard wallet yet
Kamui does not register itself with the [wallet standard](https://github.com/wallet-standard/wallet-standard) that get-starknet v5 and later discover wallets through, and wallet pickers built for extensions expect `connect` to return rather than leave the page. Test the picker you use before relying on it.
:::
