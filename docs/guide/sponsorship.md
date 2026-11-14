# Sponsorship

Kamui pays the fees of session calls for **approved apps**. Your browser code signs a call with the session key; your **server** forwards it with your app's credential; Kamui checks the credential, the account and your budget, and submits it.

```
browser ──{ account, calldata }──▶ your server ──+ x-kamui-app-key
                                                 + x-kamui-sponsor-token ──▶ sepolia.kamui.page/api/sponsor
                                                                             ◀── { transaction_hash }
```

## Getting approved

Ask the Kamui team to register your app.

<!-- TODO(kamui-team): replace this block with the real contact or request form. Issue #18. -->
::: danger Placeholder: where to ask is not decided yet
**The contact or form for requesting sponsorship has not been published.** This paragraph is a placeholder until the Kamui team names one.
:::

Registration sets your budget (transactions and fees per period, per account and overall) and gives you:

| Value | Where it goes |
|---|---|
| App key, e.g. `my_game_sepolia_01` | Your server. It is public, but only the server needs it. |
| Sponsor token | Your server's secrets. **Never** in browser code, config served to the browser, Git or screenshots. Kamui stores only its SHA-256. |

Registration itself is still done by the Kamui team. Once you have the two values, your server can read its [usage and limits](#usage-and-limits) and [rotate its token](#rotating-or-revoking-your-token) without asking anyone. There is no dashboard.

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

## Usage and limits

Your server can ask what your app has spent and what is left. Same two headers as the sponsor route, `POST`, a JSON body:

```sh
curl -X POST https://sepolia.kamui.page/api/sponsor/usage \
  -H 'content-type: application/json' \
  -H "x-kamui-app-key: $KAMUI_APP_KEY" \
  -H "x-kamui-sponsor-token: $KAMUI_SPONSOR_TOKEN" \
  -d '{}'
```

```json
{
  "limits": {
    "periodSeconds": 3600,
    "txPerPeriod": 500,
    "perAccountPerPeriod": 50,
    "maxFeePerTx": "20000000000000000000",
    "maxFeePerPeriod": "1000000000000000000000",
    "perAccountMaxFeePerPeriod": "200000000000000000000"
  },
  "usage": { "tx": 12, "fee": "340000000000000000", "txRemaining": 488, "feeRemaining": "999660000000000000000" },
  "paused": false,
  "credentialRotatedAt": null
}
```

- Fees are in fri (10⁻¹⁸ STRK) as decimal strings. The numbers above are an example, not your limits.
- `usage` covers the last `periodSeconds`, counted back from now. It is a rolling window, so budget comes back as old calls leave it, not at a fixed time.
- `fee` is what was **reserved**: the maximum fee of each call, debited before it is sent and not refunded for a revert or a timeout. It is not what the calls cost on chain.
- Send `{ "account": "0x…" }` to also get `account`: the same four numbers for one user's account, against `perAccountPerPeriod` and `perAccountMaxFeePerPeriod`.
- `paused` is the operator's pause. While it is `true`, sponsored calls fail with `SPENDING_PAUSED`.
- You see your own app only. Kamui also has a budget shared by all apps; when that is spent a call fails with `FUNDING_CAP` even though you have budget left, and this route does not show it.

## Rotating or revoking your token

Rotate on a schedule, when someone who knew the token leaves, or the moment you suspect it leaked:

```sh
curl -X POST https://sepolia.kamui.page/api/sponsor/token/rotate \
  -H 'content-type: application/json' \
  -H "x-kamui-app-key: $KAMUI_APP_KEY" \
  -H "x-kamui-sponsor-token: $KAMUI_SPONSOR_TOKEN" \
  -d '{}'
# { "token": "<new token>", "rotatedAt": 1790000000000 }
```

- The old token stops working **at once**, for every route. There is no overlap: calls your server sends with the old token after this fail with `APP_AUTH_REQUIRED` until you deploy the new one.
- The new token is in this one answer and nowhere else. Kamui keeps only its SHA-256 and cannot show it again. Write it straight to your secret store; do not log the response.
- If the answer is lost (a timeout, a crash before you saved it), neither token works any more. Ask the Kamui team to issue a new one.
- An app may change its token 5 times an hour (`CREDENTIAL_CHANGE_LIMIT` after that).

`POST /api/sponsor/token/revoke` with the same headers ends the token **without** a replacement and answers `{ "revokedAt": … }`. Use it to stop all spending from your app when you cannot deploy a new token right away. Only the Kamui team can issue the next one.

Anyone who holds your token can rotate or revoke it, which locks you out. That is one more reason it never leaves your server.

## Errors

Errors come back as `{ "error": "CODE" }` and `sponsor()` throws `sponsor: CODE`. The common ones:

| Code | Meaning | What to do |
|---|---|---|
| `APP_AUTH_REQUIRED` | No credential, a wrong one, or one you rotated or revoked | Check your server's headers and secrets |
| `UNKNOWN_APP_KEY` | App key not registered | Check `KAMUI_APP_KEY` |
| `SPONSOR_CAP`, `FUNDING_CAP`, `ACCOUNT_FUNDING_CAP`, `ACCOUNT_BUDGET_SPENT` | A budget is spent for this period | Wait, or ask for a larger budget |
| `SPENDING_PAUSED`, `FUNDING_DISABLED`, `SPONSOR_DISABLED` | Sponsorship is paused by the operator | Retry later |
| `FEE_ABOVE_CEILING` | The call costs more than allowed | Split the work into smaller calls |
| `ACCOUNT_NOT_DEPLOYED`, `WRONG_CLASS` | The address is not a Kamui account | Check the connection |
| `PAYMASTER_SUBMISSION_UNCERTAIN` | The transaction may have been sent | Check the chain before you retry |

A timeout or a lost answer may still have spent a nonce and budget. Reconcile with the chain before you send the same work again. Full list: [Errors](/reference/errors).
