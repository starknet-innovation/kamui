# React

This guide adds Kamui to a React app (Vite, Next.js client components or any React 18+ setup): a provider that handles the keychain's answer, a connect button, sponsored session calls and one-off approvals.

The code on this page is type-checked against the SDK in CI. The full files are in [`docs/snippets/react`](https://github.com/starknet-innovation/kamui/tree/main/docs/snippets/react).

## Installation

Vendor the SDK and alias `@kamui/sdk` as in the [Quickstart](/guide/quickstart#_1-add-the-sdk), then:

::: code-group

```sh [npm]
npm install starknet@10.8.0
```

```sh [pnpm]
pnpm add starknet@10.8.0
```

```sh [bun]
bun add starknet@10.8.0
```

:::

## Basic setup

### 1. Configure Kamui

Keep the keychain URL, your RPC and the session you ask for in one module, outside any component.

<<< @/snippets/react/kamui.ts

### 2. Add the provider

`KamuiProvider` does three things on load:

1. reads the keychain's answer from the URL fragment, if the user just came back, and removes it from the address bar;
2. loads the stored connection;
3. checks on chain that the session is still alive (it ends when the user adds a device, revokes it, or it expires).

<<< @/snippets/react/KamuiProvider.tsx

::: tip StrictMode and SSR
The answer is read once per page load by a module-level function, so StrictMode's double effects cannot consume it twice. Everything touching `window` runs inside `useEffect` or event handlers. In Next.js, mark the provider file `'use client'`.
:::

### 3. Connect button

<<< @/snippets/react/ConnectButton.tsx

`connect()` leaves the page. When the user comes back, the provider picks up the answer. If they denied the request, `error` holds the reason.

### 4. Send transactions

Calls inside the session are signed in the browser and sent through your [sponsor route](/guide/sponsorship#your-sponsor-route). Calls outside it send the user to the keychain.

<<< @/snippets/react/PlayButtons.tsx

::: danger One-off approvals on hosted Sepolia
`execute()` (the keychain's `/execute` page) currently fails on the hosted backend with `APP_AUTH_REQUIRED`. See [Status and limitations](/guide/limitations).
:::

### 5. Put it together

<<< @/snippets/react/App.tsx

## Sponsor route

Add the handler from [Sponsorship](/guide/sponsorship#your-sponsor-route) at `/api/kamui/sponsor`. With Next.js App Router:

```ts
// app/api/kamui/sponsor/route.ts
export { POST } from '@/lib/kamui-sponsor-route';
```

With Vite only, run any small server for it, or use Vite's `server.proxy` during development to forward `/api` to it.

## Development

- `http://localhost:<port>` works as a redirect target; any other `http:` origin is refused. For a LAN IP or a phone on your network, use HTTPS (for example `vite-plugin-mkcert`).
- Don't set a `no-referrer` policy on your app. The keychain refuses requests it cannot attribute to your origin. See [Requirements for your page](/guide/quickstart#requirements-for-your-page).
- The first sign-in on a new device makes a zero-knowledge proof in the browser. It needs a recent **desktop Chromium** browser and takes tens of seconds. See [limitations](/guide/limitations).

## starknet-react

There is no `starknet-react` connector for Kamui yet, so `useAccount` and friends do not see a Kamui session. Use the `useKamui()` hook above, or pass `createSessionAccount(...)` to your own code where a starknet.js `Account` is expected (self-paid sessions only, see [Sessions](/guide/sessions#self-paid-session-transactions)).
