# Errors

## From the keychain

`finishConnect` and `finishExecute` throw `Error('keychain: <reason>')`.

| Reason | Cause |
|---|---|
| `denied by the user` | The user clicked Deny on the approval screen |
| `cancelled by the user` | The user cancelled at sign-in |
| `refused by the keychain: <problem>` | The request broke a [session rule](/guide/sessions#rules-the-keychain-enforces), and the user went back to your site |
| `the keychain could not complete the request` | Sign-in or the transaction failed, and the user went back to your site |
| `an answer arrived but nothing was asked` | No pending request in the store (other tab, cleared storage, different store) |
| `the answer is not for this request` | The answer's `id` does not match the pending request |
| `the answer is malformed` | The answer is missing a field, or an approved transaction is not `{ account, calldata }` (a keychain and an SDK of different versions) |

When the request itself cannot be read or trusted, the keychain shows the reason to the user and does not answer, so your app sees only that the user did not come back:

| Message on the keychain | Fix |
|---|---|
| `cannot tell which site sent this request` | Your page sent no referrer. Remove `no-referrer` policies; navigate with `location.assign` from your page |
| `this request was not sent by the site it names` | The page that navigated is on a different origin than `redirectUri` |
| `the redirect address must be https` | Use HTTPS, or `http://localhost` in development |
| `the redirect address must not have a fragment` | Remove `#…` from `redirectUri` |
| `bad app name` | `appName` is longer than 60 characters |

## From popup mode

`connectWithPopup`, `executeWithPopup` and `signMessageWithPopup` reject with the errors above when the keychain answered, and with a `KeychainPopupError` when it did not. See [Popup mode](/guide/popup#when-it-does-not-answer).

| `code` | Message | Cause |
|---|---|---|
| `closed` | `the popup was closed before answering` | The user closed the popup |
| `timeout` | `no answer from the popup in time` | No answer within `timeoutMs`. Also how a popup closed after the sign-in ends |
| `aborted` | `the request was cancelled` | The `signal` was aborted |
| `blocked` | `the browser blocked the popup` | Only with `fallback: 'none'`; otherwise a blocked popup becomes a redirect |

## From the sponsor endpoint

`sponsor()` throws `Error('sponsor: <CODE>')`. HTTP status in brackets.

| Code | Meaning |
|---|---|
| `APP_AUTH_REQUIRED` (403) | Missing or wrong `x-kamui-app-key` / `x-kamui-sponsor-token` |
| `UNKNOWN_APP_KEY` (403) | App key not registered |
| `BAD_ACCOUNT`, `BAD_CALLDATA` (400) | Malformed request, or more than 600 calldata felts |
| `BAD_OUTSIDE_WINDOW` (400) | The outside execution's time window is invalid |
| `ACCOUNT_NOT_DEPLOYED`, `WRONG_CLASS`, `CONTRACT_NOT_FOUND` | Not a deployed Kamui account of the current class |
| `FEE_ABOVE_CEILING`, `FUNDING_FEE_CEILING` | The transaction costs more than the per-transaction cap |
| `SPONSOR_CAP`, `FUNDING_CAP` | Your app's or the global budget for the period is spent |
| `ACCOUNT_FUNDING_CAP`, `ACCOUNT_BUDGET_SPENT` | This account's budget for the period is spent |
| `SPENDING_PAUSED`, `FUNDING_DISABLED`, `SPONSOR_DISABLED` | Sponsorship is paused or off |
| `PAYMASTER_SUBMISSION_UNCERTAIN` | The transaction may have been sent. Check the chain before retrying |
| `API_UNAVAILABLE` (502) | The backend did not answer in time |

Budget is debited **before** a transaction is sent and is not refunded for timeouts or reverts.

## On chain

A sponsored call that passes the sponsor checks can still revert. The account refuses, among others, a call outside the session's scope, an amount above a spending limit, an expired or revoked session, and a nonce outside the session's range.

To tell an ended session from the other refusals, call `checkSessionEnded` after the failure. See [When a call fails](/guide/sessions#when-a-call-fails).
