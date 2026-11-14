# Svelte

This guide adds Kamui to a Svelte 5 or SvelteKit app. The state lives in one module of runes that any component can import.

The full files are in [`docs/snippets/svelte`](https://github.com/starknet-innovation/kamui/tree/main/docs/snippets/svelte). The `.svelte.ts` module is type-checked against the SDK in CI.

## Installation

Install the SDK and `starknet`. Before the first npm release, install the SDK from a file as in the [Quickstart](/guide/quickstart#_1-add-the-sdk).

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

## Setting up Kamui

`src/lib/kamui.svelte.ts` holds the configuration and a `kamui` object with reactive `status`, `connection`, `error` and `lastExecuted`, and the methods `init`, `connect`, `disconnect`, `send` and `execute`.

<<< @/snippets/svelte/kamui.svelte.ts

## Connecting and disconnecting

`init()` must run in the browser, once, before anything reads the session. In SvelteKit call it from `onMount` in your root `+layout.svelte` or `+page.svelte`. It reads the keychain's answer from the URL fragment, removes it from the address bar, and checks on chain that the session is still alive.

## Displaying user information

<<< @/snippets/svelte/UserInfo.svelte

## Performing transactions

`kamui.send(calls)` signs inside the session and sends through your sponsor route. `kamui.execute(calls)` sends the user to the keychain for a one-off approval.

<<< @/snippets/svelte/Play.svelte

::: danger One-off approvals on hosted Sepolia
`execute()` currently fails on the hosted backend with `APP_AUTH_REQUIRED`. See [Status and limitations](/guide/limitations).
:::

## Sponsor route

In SvelteKit, put the handler from [Sponsorship](/guide/sponsorship#your-sponsor-route) in `src/routes/api/kamui/sponsor/+server.ts`. Read the secrets with `$env/static/private` instead of `process.env` if you prefer.

## Full example

`src/routes/+page.svelte`, with the module and components in `src/lib`:

<<< @/snippets/svelte/+page.svelte

## Notes

- The module is safe to import during SSR, but `init`, `connect`, `disconnect` and `execute` use `localStorage` and `location`: call them only in the browser (`onMount`, event handlers).
- The keychain answers to `redirectUri`, which this module sets to the current path. If you use client-side routing, make sure that path renders the component that calls `init()`.
