# Sponsorship

Kamui pays the fees of session calls for **approved apps**. Your browser code signs a call with the session key; your **server** forwards it with your app's credential; Kamui checks the credential, the account and your budget, and submits it.

```
browser ──{ account, calldata }──▶ your server ──+ x-kamui-app-key
                                                 + x-kamui-sponsor-token ──▶ sepolia.kamui.page/api/sponsor
                                                                             ◀── { transaction_hash }
```

## Getting approved

Ask the Kamui team to register your app. Registration sets your budget (transactions and fees per period, per account and overall) and gives you:

| Value | Where it goes |
|---|---|
| App key, e.g. `my_game_sepolia_01` | Your server. It is public, but only the server needs it. |
| Sponsor token | Your server's secrets. **Never** in browser code, config served to the browser, Git or screenshots. Kamui stores only its SHA-256. |

There is no self-serve registration or dashboard yet.

## Your sponsor route

A plain `Request → Response` handler. It works as a Next.js route handler, a SvelteKit `+server.ts`, in Hono, Bun or Remix:

<<< @/snippets/server/sponsor-route.ts

::: warning Kamui approves your app, not your users
Anyone who can call your route can spend your budget, within what each user's session allows. Put your own checks in front of it: your login, per-user or per-IP rate limits, a captcha, an allow-list.
:::

In the browser, pass your route to `sponsor`:

```ts
const hash = await sponsor('/api/kamui/sponsor', prepared.call);
```

A server that holds the credential itself can call Kamui directly, see the [Node.js example](/examples/node).

## What Kamui checks

- The app key and token match a registered app.
- The account is a deployed Kamui account of the expected class.
- The call is an `execute_from_outside_v2` the account will accept, with a fee within limits.
- Your app's budget, the account's budget and the global budget are not spent.

The **account** is the authority over what the call may do: a call outside the session's scope or limits fails on chain no matter who submits it.

## Errors

Errors come back as `{ "error": "CODE" }` and `sponsor()` throws `sponsor: CODE`. The common ones:

| Code | Meaning | What to do |
|---|---|---|
| `APP_AUTH_REQUIRED` | No credential, or a wrong one | Check your server's headers and secrets |
| `UNKNOWN_APP_KEY` | App key not registered | Check `KAMUI_APP_KEY` |
| `SPONSOR_CAP`, `FUNDING_CAP`, `ACCOUNT_FUNDING_CAP`, `ACCOUNT_BUDGET_SPENT` | A budget is spent for this period | Wait, or ask for a larger budget |
| `SPENDING_PAUSED`, `FUNDING_DISABLED`, `SPONSOR_DISABLED` | Sponsorship is paused by the operator | Retry later |
| `FEE_ABOVE_CEILING` | The call costs more than allowed | Split the work into smaller calls |
| `ACCOUNT_NOT_DEPLOYED`, `WRONG_CLASS` | The address is not a Kamui account | Check the connection |
| `PAYMASTER_SUBMISSION_UNCERTAIN` | The transaction may have been sent | Check the chain before you retry |

A timeout or a lost answer may still have spent a nonce and budget. Reconcile with the chain before you send the same work again. Full list: [Errors](/reference/errors).
