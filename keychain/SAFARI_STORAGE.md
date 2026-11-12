# Safari storage loss: decision and test evidence

Status: 2026-11-12. Browser-storage mechanics and Kamui's response to modeled loss are checked below. **Safari's naturally elapsed seven-use-day ITP purge is not verified.** This is not a production browser-support sign-off.

## What the policy means

WebKit documents removal of script-written storage, including IndexedDB, localStorage and sessionStorage, after seven days **of Safari use** without user interaction with the site. This is not simply seven calendar days after a write. A page reload, timer or background fetch is not a demonstrated substitute for user interaction. See [WebKit's original explanation](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/) and [its tracking-prevention documentation](https://webkit.org/tracking-prevention/).

WebKit also documents a first-party exception for Home Screen web apps, whose storage is isolated from Safari. That does not establish that Kamui's full-page redirects from a dapp will open the installed app or share its key. We have not implemented or tested that flow. Do not sell installation as a guaranteed remedy.

Safari supports `navigator.storage.persisted()` / `persist()` and grants persistence using heuristics. A `persisted()` result is not a backup and no persistence request was made in this work. See [WebKit's storage-policy explanation](https://webkit.org/blog/14403/updates-to-storage-policy/).

## Kamui's behavior and UX decision

Treat the browser's device key as disposable local state, not a backup. Do not try to bypass tracking prevention, move the key to cookies, extend its life through a keepalive, or infer a deletion date from the device clock. There is no reliable local distinction between a first visit and a complete storage purge, because the record of the previous visit is lost too.

The sign-in screen now warns that storage loss requires another sign-in, that the new key ends every session, and that the recovery file does not restore the device key or preserve sessions. The account screen asks users to keep the recovery file outside the browser and explains that a lost key can remain listed on chain. The warning is shown in every browser; no user-agent claim is needed.

Deleting local storage does not delete the account, remove its owner key, or revoke sessions on chain. Signing in again under the same issuer, OAuth client, account class and pepper derives the same address, adds a new device key and revokes all sessions (D5). With five keys, the account's existing recovery rule replaces the oldest; otherwise the lost key remains until removed. An exported recovery file supplies the pepper if the lookup service fails. The user still needs the issuer sign-in. If both the pepper service and the recovery file are unavailable, another sign-in cannot reconstruct the pepper.

No new device-key export, passkey, native keychain, PWA or account/recovery architecture is introduced. Those would need their own security review.

## Observed in native Safari

Native Safari **27.2** on the user's Mac, ordinary window, isolated fixture origin `http://127.0.0.1:5193/`. No real wallet key, pepper, account, login token or network transaction was used. The fixture writes a fixed string that is deliberately not a valid private key through the real `keychain/src/vault.ts` encryption/storage functions.

Observed on 2026-11-12:

1. Write succeeded: vault marker recovered, wrapping key present, `extractable: false`, local/session markers present, `persisted(): false`.
2. Reload recovered the marker through the stored non-exportable AES-GCM key.
3. The fixture's explicit loss button deleted only this origin's disposable database and markers. The next read found no marker or wrapping key.
4. Writing fresh data worked again. A fresh baseline was seeded at **2026-11-12T14:14:31.365Z (15:14:31 CET)**, then the probe tab was closed.

The recorded booleans are in [evidence/safari-storage-2026-11-12.json](evidence/safari-storage-2026-11-12.json). This checks native Safari mechanics, not ITP's deletion scheduler. Loopback origin handling can differ from a production domain; retaining the loopback marker after a week would not disprove the policy.

## Reproduce the mechanics check

From `keychain/`, using the pinned Bun binary:

```sh
/Users/adrienlacombe/ws/kamui/spikes/s1/tools/node_modules/.bin/bun run scripts/safari-storage-probe.ts
```

Open `http://127.0.0.1:5193/` in native Safari. The fixture binds loopback only and uses a separate origin from the wallet. Use **Write disposable probe**, reload, and read the visible booleans. **Simulate storage loss for this probe** affects only the fixture's test database/markers. Never use a real key or sign in on this fixture. Stop the fixture when done. Restarting it at the same origin can re-read the current baseline; changing the host, scheme or port would make it a different origin.

## Naturally elapsed ITP check still to do

Use a dedicated, reviewed HTTPS test origin serving only this benign fixture, in native Safari with normal privacy settings. Record the Safari/OS version, origin, storage state and seed time outside that origin. Close the tab, use Safari on other sites over at least seven days of actual Safari use, and do not interact with the test site during that interval. Do not advance the system clock, disable protections, call private test hooks, or clear site data. On the eventual revisit, record whether the IndexedDB/wrapping/local/session markers survived and repeat on the target mobile Safari versions. The revisit itself can affect later trials, so use a separate trial origin/profile as appropriate.

The local baseline began on 12 November; a calendar checkpoint on or after 19 November alone does not establish seven Safari-use days, and localhost is not the required production-like HTTPS origin. A fixture host/domain and naturally elapsed usage are still required before claiming ITP eviction was observed. No reminder or automation was created.

## Automated consequence tests

`tests/storage-loss.spec.ts` explicitly deletes all keychain-origin IndexedDB/local/session storage in disposable Playwright contexts. It verifies that local deletion sends no revocation or recovery, that fake on-chain owners/sessions survive until sign-in, that a fresh sign-in adds a different key at the same address and ends sessions, and that an externally downloaded recovery file works with the fake pepper service down. The issuers, chain and services are fakes. These tests exercise Chrome, Firefox and Playwright WebKit; **none is evidence that Safari's ITP timer fired**.
