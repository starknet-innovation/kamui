# Starknet Start

`KamuiStandardWallet` puts a Kamui session behind [Starknet Start](https://github.com/starknet-innovation/starknet-start), the React hooks for Starknet built on get-starknet 6: `useAccount`, `useConnect`, `useDisconnect`, `useSendTransaction` and `useSignTypedData` work as they do with an extension wallet. Calls inside the session are signed in the browser and sent through your [sponsor route](/guide/sponsorship#your-sponsor-route) without a prompt.

The code on this page is type-checked against the SDK in CI. The full files are in [`docs/snippets/starknet-start`](https://github.com/starknet-innovation/kamui/tree/main/docs/snippets/starknet-start).

::: info Versions
Written and tested against `@starknetfoundation/starknet-start-react` 2.0.3 with `starknet` 10.8.0 and React 19. Starknet Start asks for `starknet >=10.4.0` and `react >=19`, so it installs next to the SDK without peer-dependency warnings or overrides.
:::

## Installation

Install the SDK with `starknet`, React and Starknet Start. Before the first npm release, install the SDK from a file as in the [Quickstart](/guide/quickstart#_1-add-the-sdk).

::: code-group

```sh [npm]
npm install @kamui/sdk starknet@10.8.0 react@19 react-dom@19 \
  @starknetfoundation/starknet-start-react@2.0.3 \
  @starknetfoundation/starknet-start-chains @starknetfoundation/starknet-start-providers \
  @starknet-io/get-starknet-core@6 @starknet-io/get-starknet-modal@6 @starknet-io/get-starknet-wallet-standard@6
```

```sh [pnpm]
pnpm add @kamui/sdk starknet@10.8.0 react@19 react-dom@19 \
  @starknetfoundation/starknet-start-react@2.0.3 \
  @starknetfoundation/starknet-start-chains @starknetfoundation/starknet-start-providers \
  @starknet-io/get-starknet-core@6 @starknet-io/get-starknet-modal@6 @starknet-io/get-starknet-wallet-standard@6
```

```sh [bun]
bun add @kamui/sdk starknet@10.8.0 react@19 react-dom@19 \
  @starknetfoundation/starknet-start-react@2.0.3 \
  @starknetfoundation/starknet-start-chains @starknetfoundation/starknet-start-providers \
  @starknet-io/get-starknet-core@6 @starknet-io/get-starknet-modal@6 @starknet-io/get-starknet-wallet-standard@6
```

:::

The adapter is the `@kamui/sdk/starknet-start` entry point of the same package. No alias is needed.

The three `@starknet-io/get-starknet-*` packages are peer dependencies of Starknet Start. `@kamui/sdk` itself does not import React, Starknet Start or get-starknet; only `@kamui/sdk/starknet-start` does.

## 1. Create the wallet

One wallet for the app, outside any component. It takes the keychain, a provider, how calls are paid for, and the [session](/guide/sessions#what-you-ask-for) to ask for.

<<< @/snippets/starknet-start/kamui.ts

| Option | |
|---|---|
| `keychainUrl` | The keychain to send the user to. |
| `provider` | Reads the account: is the session alive, which sponsored nonce is next. |
| `session` | What to ask for. A function is called when the user connects. |
| `sponsor` | A URL (your sponsor route) or `(call) => Promise<transactionHash>`. Leave it out for [self-paid](/guide/sessions#self-paid-session-transactions) session transactions. |
| `store` | Where the session key is kept. Defaults to `localStorage`. |

A second argument, `{ watch }`, controls [watching the session](#when-the-session-ends).

In Starknet Start a connector is a [wallet-standard](https://github.com/wallet-standard/wallet-standard) wallet, and `KamuiStandardWallet` is one: `name`, `icon`, `chains`, `accounts`, and the features `standard:connect`, `standard:disconnect`, `standard:events` and `starknet:walletApi`.

## 2. Add the providers

Pass the wallet as `extraWallets`. `useConnect().connectors` then lists it after the extension wallets get-starknet discovers.

<<< @/snippets/starknet-start/Providers.tsx

### Why `useKamuiReconnect`

Connecting is a full-page redirect. `connect()` sends the user to the keychain and never returns to the code that called it; the page that finishes the connection is the one the keychain sends the user back to. `useKamuiReconnect(wallet)` does that on every page load:

1. reads the keychain's answer from the URL fragment, if the user just came back, and removes it from the address bar;
2. loads the stored session and checks on chain that it is still alive;
3. connects the wallet through Starknet Start, without a redirect, if there is a live session.

It returns `isResuming`, the keychain's `error` if the user refused, and `lastApproved`, the hash of a [one-off transaction](#calls-outside-the-session) the user just approved. It never redirects by itself. Starknet Start does not reconnect a wallet on its own after a reload, so without the hook the user would have to click connect again on every visit.

In Next.js, mark the providers file `'use client'`. On the server the wallet finds no session and does nothing.

## 3. Connect, send and sign

<<< @/snippets/starknet-start/Game.tsx

`useSignTypedData` signs a SNIP-12 message with the session key: `[session_pubkey, r, s, valid_until]`, no prompt. The account accepts that signature for as long as the session lives; check it with [`verifyMessageSignature`](/reference/sdk#signing-messages). It is not an owner signature: it stops verifying when the session ends.

## What is refused

A session is not the whole account. The wallet refuses, **before anything is signed or sent**, with a `KamuiWalletError` whose `code` says why:

| `code` | When | What to do |
|---|---|---|
| `OUT_OF_SCOPE` | A call is not one of the session's `calls`. `error.calls` lists them. | Ask for it in `session`, or [have it approved in the keychain](#calls-outside-the-session). |
| `SESSION_EXHAUSTED` | All `maxCalls` sponsored calls are used. | `wallet.wallet.renew()`, or disconnect and connect again. |
| `SESSION_EXPIRED` | The session is past `validUntil`. | Same. |
| `NOT_CONNECTED` | There is no session. | Connect. |
| `UNSUPPORTED` | `useSwitchChain` to another chain, a message whose domain names another chain, `useDeclareContract`, `useWatchAsset`, `useAddChain` and the STRK20 hooks. | A session cannot do these. |

The hooks surface it as their `error`. Limits the app cannot check ahead (a [spending limit](/guide/sessions#what-you-ask-for), a session revoked a moment ago) still come back from the sponsor route or the network, see [Errors](/reference/errors).

::: tip Chains
A session lives on the keychain's chain. If that is not the first of your `chains`, Starknet Start asks the wallet to switch on connect, the wallet refuses, and Starknet Start falls back to the session's chain with a console warning. List the keychain's chain first, or set `defaultChainId` to it.
:::

### Calls outside the session

`wallet.wallet.approveInKeychain(calls, appName)` sends the user to the keychain to approve one transaction with the account's full authority. Like connecting, it leaves the page; `useKamuiReconnect` reports the transaction hash as `lastApproved` on the way back.

::: danger One-off approvals on hosted Sepolia
The keychain's `/execute` page currently fails on the hosted backend with `APP_AUTH_REQUIRED`. See [Status and limitations](/guide/limitations).
:::

## When the session ends

A session ends when it expires, when the user revokes it, and when they add or remove a device. While connected, the wallet [watches for that](/guide/sessions#when-a-session-ends) and announces it as a `change` event with no accounts: `useAccount` goes to `disconnected`, and `wallet.lastEnd` holds the reason (`expired`, `revoked`, `all-revoked`, `owners-changed`, `gone`).

By default that is one read of the account's events every 30 seconds. Pass `watchSession` options to change it, or `false` to turn it off:

```ts
new KamuiStandardWallet(options, { watch: { pollIntervalMs: 10_000 } });
new KamuiStandardWallet(options, { watch: false });
```

## Without Starknet Start

`KamuiStandardWallet` is a thin wrapper around `KamuiWallet` from `@kamui/sdk`, which has the shape get-starknet 4 calls a wallet object: `id`, `name`, `icon`, `request`, `on`, `off`. Use it directly with starknet.js's `WalletAccount`, or expose it as `window.starknet_kamui`:

<<< @/snippets/starknet-start/get-starknet.ts

Both answer `wallet_getPermissions`, `wallet_requestAccounts` (with `silent_mode` it never redirects; without, it connects), `wallet_requestChainId`, `wallet_switchStarknetChain` (to the session's own chain only), `wallet_addInvokeTransaction`, `wallet_signTypedData` and `wallet_supportedWalletApi`. Everything else is refused with `UNSUPPORTED`.

With another get-starknet 6 app, pass the `KamuiStandardWallet` wherever it takes extra wallets, or use it with starknet.js's `WalletAccountV6`. It is not announced through wallet-standard discovery (`registerWallet`): your app lists it. Wallet pickers built for extensions expect `connect` to return rather than leave the page, so test the picker you use.

## Coming from the starknet-react connector

`@kamui/sdk/starknet-react` (`KamuiConnector`, for `@starknet-react/core` 5) is gone: starknet-react 5 asks for `starknet ^8`, which the SDK's `starknet` 10 does not satisfy. To move:

| Before | Now |
|---|---|
| `@starknet-react/core`, `@starknet-react/chains`, React 18 | `@starknetfoundation/starknet-start-react`, `@starknetfoundation/starknet-start-chains`, React 19 |
| `import … from '@kamui/sdk/starknet-react'` | `import … from '@kamui/sdk/starknet-start'` |
| `new KamuiConnector(options)` | `new KamuiStandardWallet(options)`, same options |
| `<StarknetConfig connectors={[kamui]}>` | `<StarknetConfig extraWallets={[kamui]}>` |
| `useKamuiReconnect(connector)` | `useKamuiReconnect(wallet)`, same result |
| `connector.id`, `connector.available()`, `connector.ready()` | `wallet.features['starknet:walletApi'].id`, `wallet.wallet.available()`, `wallet.wallet.resume()` |
| `useSignTypedData` refused | signs with the session key |
| a session that ended stayed "connected" until a call failed | `useAccount` goes to `disconnected` |
