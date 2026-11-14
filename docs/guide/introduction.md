# Introduction

Kamui is an embedded wallet for Starknet apps. Your users sign in with Google on a shared **keychain** page, get a Starknet smart account, and approve a **session**: a key your app holds that may make only the calls they agreed to. Your app then signs those calls itself, and Kamui **sponsors** the fees.

## How it works

```
 Your app                          Kamui keychain                      Starknet
 ────────                          ──────────────                      ────────
 1. creates a session key
    and redirects ───────────────▶ 2. signs the user in (Google)
                                      shows what the session may do
                                      user approves ─────────────────▶ session registered
 4. reads the answer ◀───────────  3. redirects back with the            on the account
    from the URL fragment             account address
 5. signs calls with the
    session key ──▶ your server ──▶ Kamui sponsor ───────────────────▶ executed, fee paid
                    (adds credential)                                   by Kamui
```

- **Redirects, not popups or iframes.** The keychain is a normal page that your app navigates to, like an OAuth login. Your page reloads when the user comes back. That avoids third-party storage partitioning and lost `window.opener` references.
- **The session key never leaves your app.** The keychain only approves what it may do. The user's device key never leaves the keychain.
- **The account enforces the session.** Scope, expiry, call count and spending limits are checked by the account contract on chain, not by Kamui's servers.
- **Two ways to send.** Calls *inside* the session are signed by your app with no prompt. Calls *outside* it go back to the keychain for a one-off approval (`/execute`).

## What you build with

| You need | Use |
|---|---|
| Connect, send session calls, one-off approvals in a browser app | [`@kamui/sdk`](/reference/sdk) app-side helpers. See [React](/examples/react) or [Svelte](/examples/svelte). |
| A bot, script or game server acting for a user | The same helpers plus a localhost round trip. See [Node.js](/examples/node). |
| A mobile app | Not supported yet. See [Native](/native/overview). |
| Fees paid for your users | An approved app key and a small server route. See [Sponsorship](/guide/sponsorship). |
| Another language | The [keychain protocol](/reference/protocol) is plain JSON in a URL fragment. |

## Built on standards

Kamui accounts implement SNIP-5, SNIP-6, SNIP-9 (outside execution, used for sponsorship), SNIP-12 (typed data) and SNIP-41 (session keys with spending policies). Login proofs use SNIP-36 and are made in the user's browser.

::: info
Kamui is a development preview on **Sepolia**. Read [Status and limitations](/guide/limitations) before you build on it.
:::
