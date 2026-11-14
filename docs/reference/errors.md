# Errors

## From the keychain

`finishConnect`, `finishExecute` and `finishSignMessage` throw `Error('keychain: <reason>')`. When the keychain answered with a refusal, the error is a `KeychainAnswerError` and its `reason` property holds the reason without the prefix.

| Reason | Cause |
|---|---|
| `denied by the user` | The user clicked Deny on the approval screen |
| `cancelled by the user` | The user cancelled at sign-in |
| `refused by the keychain: <problem>` | The request broke a [session rule](/guide/sessions#rules-the-keychain-enforces), and the user went back to your site |
| `referrer_missing` | The request reached the keychain with no referrer, and the user chose to come back. Test for it with `isReferrerMissing(error)`. See [Troubleshooting: the referrer](#troubleshooting-the-referrer) |
| `the keychain could not complete the request` | Sign-in or the transaction failed, and the user went back to your site |
| `an answer arrived but nothing was asked` | No pending request in the store (other tab, cleared storage, different store) |
| `the answer is not for this request` | The answer's `id` does not match the pending request |
| `the answer is malformed` | The answer is missing a field |

When the request itself cannot be read or trusted, the keychain shows the reason to the user and does not answer, so your app sees only that the user did not come back. The one exception is a missing referrer, where the user can choose to come back with `referrer_missing`.

| Message on the keychain | Fix |
|---|---|
| `cannot tell which site sent this request` | The request arrived with no referrer. See [Troubleshooting: the referrer](#troubleshooting-the-referrer) |
| `this request was not sent by the site it names` | The page that navigated is on a different origin (scheme, host and port) than `redirectUri`. A `www` subdomain or a hop through another domain counts as different |
| `the redirect address must be https` | Use HTTPS, or `http://localhost` in development |
| `the redirect address must not have a fragment` | Remove `#…` from `redirectUri` |
| `bad app name` | `appName` is longer than 60 characters |

## Troubleshooting: the referrer

The keychain cannot authenticate your app in a redirect. It accepts a request only when the browser's referrer says it came from a page on the origin of `redirectUri`. With no referrer it refuses, tells the user why, and lists what they can change.

**Why the referrer goes missing**

| Cause | Who can fix it | Fix |
|---|---|---|
| Your page is served with `Referrer-Policy: no-referrer` or `same-origin` (often a security-header default) | You | Serve the page that opens the keychain with `Referrer-Policy: strict-origin-when-cross-origin`, the browser default. It sends your origin only, never the path |
| `<meta name="referrer" content="no-referrer">` on the page | You | Remove it, or set `content="strict-origin-when-cross-origin"` |
| The link or call that opens the keychain has `rel="noreferrer"` or `referrerpolicy="no-referrer"`, or uses `window.open(url, '_blank', 'noreferrer')` | You | Remove them. `location.assign(url)` from your page is enough. If the rest of the page must stay `no-referrer`, open the keychain with a link that has `referrerpolicy="strict-origin-when-cross-origin"` |
| The request was opened from the address bar, a bookmark, an email or a native app | You | Start the request from a page of yours, in the browser |
| A privacy or ad-blocking extension removes referrers | The user | Turn it off for your site, or allow referrers in its settings |
| A browser privacy setting stops referrers being sent | The user | Put it back to the default, or use another browser |

To check your side, open your page's network tab, follow the navigation to the keychain, and look for a `Referer` request header holding your origin.

**What the user sees, and what your app gets back**

The keychain's page names these causes. Because nothing proves which site sent the request, it shows none of the request (not even `appName`) and never redirects by itself. It offers one link, labelled with the origin of `redirectUri`, that the user may click. The link goes to `redirectUri` with a normal answer:

```json
{ "v": 1, "id": "0x5c1e…", "ok": false, "error": "referrer_missing" }
```

It carries no account and nothing else from the request. `finishConnect`, `finishExecute` and `finishSignMessage` throw it like any refusal, and `isReferrerMissing` recognises it:

```ts
import { finishConnect, isReferrerMissing } from '@kamui/sdk';

try {
  finishConnect(location.hash, localStorage);
} catch (error) {
  if (isReferrerMissing(error)) {
    showMessage('Your browser or an extension hides which site you come from, so Kamui refused the request. Allow referrers for this site and try again.');
  } else {
    showMessage((error as Error).message);
  }
}
```

The user may also close the keychain without clicking, so your app must still cope with no answer at all. A referrer from another origin gets no link back: something asked in your site's name, and the keychain does not send the user on.

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
