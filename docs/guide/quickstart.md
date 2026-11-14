# Quickstart

This page gets a browser app from nothing to a sponsored session call. Framework walkthroughs: [React](/examples/react), [Svelte](/examples/svelte), [Node.js](/examples/node).

## 1. Add the SDK

`@kamui/sdk` is a built ESM package with type declarations. `starknet` is a peer dependency: your app installs it, and the SDK uses your copy. The SDK is tested against `starknet` 10.8.0.

::: code-group

```sh [npm]
npm install @kamui/sdk starknet@10.8.0
```

```sh [pnpm]
pnpm add @kamui/sdk starknet@10.8.0
```

```sh [bun]
bun add @kamui/sdk starknet@10.8.0
```

:::

No alias or bundler setting is needed. The package works with Vite, Next.js, SvelteKit, Bun and plain Node.js 22 or later.

::: warning Before the first npm release
`@kamui/sdk` has not been released to npm yet. Until it is, build the same package from the [Kamui repository](https://github.com/starknet-innovation/kamui) and install the file:

```sh
git clone https://github.com/starknet-innovation/kamui
(cd kamui/sdk && bun install && npm pack)   # writes kamui-sdk-0.1.0.tgz
npm install ./kamui/sdk/kamui-sdk-0.1.0.tgz starknet@10.8.0
```

Everything else on this site is the same either way.
:::

## 2. Get sponsorship credentials

Session calls are paid for by Kamui on behalf of **approved apps**. Ask the Kamui team to register your app. You receive:

- a public **app key** (`KAMUI_APP_KEY`), and
- a private **sponsor token** (`KAMUI_SPONSOR_TOKEN`) that only your server may hold.

Add the [sponsor route](/guide/sponsorship#your-sponsor-route) to your server. Without credentials, the keychain still works (users can sign in and approve sessions), but sponsored calls are refused with `APP_AUTH_REQUIRED`.

## 3. Connect

```ts
import { beginConnect } from '@kamui/sdk';

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

location.assign(
  beginConnect(
    {
      keychainUrl: 'https://sepolia.kamui.page',
      redirectUri: `${location.origin}/`,
      appName: 'My game',
      validUntil: Math.floor(Date.now() / 1000) + 24 * 3600,
      maxCalls: 200,
      calls: [{ to: GAME, entrypoint: 'move' }, { to: STRK, entrypoint: 'transfer' }],
      limits: [{ token: STRK, maxPerCall: 10n ** 18n, maxPerWindow: 5n * 10n ** 18n, windowSeconds: 86_400 }],
    },
    localStorage,
  ),
);
```

`beginConnect` creates the session key, stores it under `kamui.*` keys in the store you pass, and returns the keychain URL.

## 4. Read the answer

When the user comes back, the answer is in the URL fragment:

```ts
import { finishConnect, loadConnection } from '@kamui/sdk';

const connection = finishConnect(location.hash, localStorage) ?? loadConnection(localStorage);
history.replaceState(null, '', location.pathname); // take the answer out of the address bar
```

`finishConnect` throws if the user denied the request or the answer does not match the pending request.

## 5. Send a sponsored call

```ts
import { sessionCall, sponsor } from '@kamui/sdk';

const prepared = await sessionCall(connection, [{ contractAddress: GAME, entrypoint: 'move', calldata: ['0x1'] }], provider);
const transactionHash = await sponsor('/api/kamui/sponsor', prepared!.call);
```

That is the whole loop. Next: [what a session can and cannot do](/guide/sessions).

## Requirements for your page

- **HTTPS**, or `http://localhost` in development. Any other `http:` redirect is refused.
- **Send a referrer.** The keychain refuses a request unless `document.referrer` has the same origin as `redirectUri`. Do not serve `Referrer-Policy: no-referrer` (or `same-origin`) on the page that calls `location.assign`, do not add `<meta name="referrer" content="no-referrer">`, and do not open the keychain with `rel="noreferrer"`. The browser default (`strict-origin-when-cross-origin`) is fine.
- **Navigate from your page.** Open the keychain with `location.assign(url)` from a page on the same origin as `redirectUri`. A server-side `302` to the keychain works only if the original navigation already carries your origin as referrer.
- **No fragment in `redirectUri`.** The answer goes there.
