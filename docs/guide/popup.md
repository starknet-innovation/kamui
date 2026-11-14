# Popup mode

By default the keychain is a page your app navigates to, so your page reloads on every connect and every one-off approval. Popup mode runs the same flow in a popup window instead. Your page stays loaded, keeps its in-memory state, and gets a promise.

It is opt-in, and it falls back to the redirect when the browser blocks the popup.

<<< @/snippets/popup/connect.ts

## What you have to do

1. **Call `relayPopupResult()` first** on the page `redirectUri` names. In the popup it hands the answer to the page that opened it, closes the window and returns `true`: draw nothing else. Everywhere else it returns `false`.
2. **Call `connectWithPopup` / `executeWithPopup` / `signMessageWithPopup` directly from a click or key handler**, with nothing awaited before it. Browsers only allow a popup during a user action.
3. **Keep the redirect path working.** A blocked popup becomes an ordinary redirect (the page leaves, the promise never settles), and the user comes back to `finishConnect` / `finishExecute` / `finishSignMessage` as in the [Quickstart](/guide/quickstart#_4-read-the-answer). Pass `{ fallback: 'none' }` to get a `blocked` rejection instead.

The requirements for your page are the same as for redirects: it must send a referrer, and `redirectUri` must be on your page's origin. Do not open the popup with `noopener` or `noreferrer`.

## How it works

```
 your page                                popup
 connectWithPopup() ─── window.open ───▶  keychain /connect#kamui=<request>
      │                                   sign-in at Google if needed, then approval
      │                                   keychain navigates to redirectUri#kamui=<answer>
      │                                   your page, in the popup: relayPopupResult()
      ◀──── BroadcastChannel (your origin only) ────┘   the popup closes
```

The keychain does exactly what it does for a redirect: it checks that the request came from a page on the origin of `redirectUri`, and it sends the answer to `redirectUri` and nowhere else. The popup therefore ends on **your own page**, and the last hop, from that page to the page that is waiting, is a `BroadcastChannel`, which the browser delivers only within your origin. The waiting page accepts an answer only if it carries the id of its pending request.

In popup mode the pending request, and with it the session's private key, stays in your page's memory. It is not written to the store. The connection is stored when it arrives, as after a redirect.

Nothing relies on `window.opener`. Signing in at an issuer whose pages set `Cross-Origin-Opener-Policy` cuts the link between the two windows: the popup loses `window.opener`, and your page's handle on the popup reports `closed` while the window is still open. The answer still arrives, because it travels by `BroadcastChannel`. The keychain tells your page when it is about to leave for the issuer, and from then on a popup that looks closed is not treated as closed.

While the popup is open, the keychain (and an issuer that does not isolate its pages) holds a reference to your window and could navigate it, as any page you open without `noopener` can. `noopener` is not an option here: your page would get no handle on the popup, and could not tell a blocked or a closed one.

## When it does not answer

`executeWithPopup` resolves with `{ account, call }`, like `finishExecute`: the keychain signs the transaction and does not send it. Send `call` through your [sponsor route](/guide/sponsorship#your-sponsor-route) with `sponsor(url, call)`, once, within 10 minutes; see [one-off approvals](/guide/sessions#outside-the-session-one-off-approvals).

`connectWithPopup`, `executeWithPopup` and `signMessageWithPopup` reject with the keychain's reason (`keychain: denied by the user`, …) when there is an answer, and with a `KeychainPopupError` when there is none. Its `code` is one of:

| `code` | Meaning |
|---|---|
| `closed` | The user closed the popup before answering |
| `timeout` | No answer within `timeoutMs` (default 10 minutes) |
| `aborted` | You aborted the `signal` you passed |
| `blocked` | The browser blocked the popup and you passed `fallback: 'none'` |

## Limits

- **A closed popup is only noticed before the sign-in.** Once the popup has gone to the issuer, your page can no longer tell whether it is open. If the user closes it after that, the promise settles on the timeout. Give the user a cancel button wired to an `AbortSignal`.
- **The popup may not close itself.** If the browser refuses `window.close()`, the window stays on your page. Show a line asking the user to close it, as the example does.
- **An app inside someone else's iframe** has its `BroadcastChannel` partitioned away from the popup's. The relay also posts to `window.opener`, which covers the case where no sign-in was needed; after a sign-in at an issuer that isolates its pages, the answer cannot reach a framed app, and the promise settles on the timeout.
- **A keychain older than this feature** does not announce the trip to the issuer, so a sign-in there can be mistaken for a closed popup.
- **Mobile browsers** open a "popup" as a new tab. The flow is the same, but in-app browsers (webviews) often block new windows altogether, and you get the redirect.
- **Tested in Chromium only**, against a fake issuer. The browser tests cover Chrome, including an issuer that isolates its pages. Firefox, Safari and the real Google sign-in have not been exercised in popup mode.
- **The wallet interface does not use it.** `KamuiWallet` and the starknet-react connector still redirect.
- **No iframe mode.** Embedding the keychain needs the Storage Access API and a keychain that allows framing; it does not exist.
