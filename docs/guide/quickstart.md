# Quickstart

This page gets a browser app from nothing to a sponsored session call. Framework walkthroughs: [React](/examples/react), [Svelte](/examples/svelte), [Node.js](/examples/node).

## 1. Add the SDK

::: warning Not on npm yet
`@kamui/sdk` is not published as a package. Until it is, copy `sdk/` from the [Kamui repository](https://github.com/starknet-innovation/kamui) into your project (or add the repository as a git submodule) and alias the import.
:::

```sh
git submodule add https://github.com/starknet-innovation/kamui vendor/kamui
npm install starknet@10.8.0
```

Point `@kamui/sdk` at the TypeScript source. The SDK uses `starknet` 10.8.0; make sure your app resolves the same copy.

::: code-group

```ts [vite.config.ts]
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@kamui/sdk': fileURLToPath(new URL('./vendor/kamui/sdk/src/index.ts', import.meta.url)) },
    dedupe: ['starknet'],
  },
});
```

```json [tsconfig.json]
{
  "compilerOptions": {
    "paths": { "@kamui/sdk": ["./vendor/kamui/sdk/src/index.ts"] }
  }
}
```

:::

## 2. Get sponsorship credentials

Session calls are paid for by Kamui on behalf of **approved apps**. Ask the Kamui team to register your app (see [Getting approved](/guide/sponsorship#getting-approved)). You receive:

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
