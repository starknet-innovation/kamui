# Adding a device from one that is already signed in

Status, 14 November 2026: implemented in the keychain and covered by browser tests against fakes. **Not run on a phone, not run against Sepolia, and not security reviewed.** It does not let a new user sign up on a phone: the first sign-in of an account still needs a desktop Chromium (see [CLIENT_PROVING.md](CLIENT_PROVING.md)).

## The problem it addresses

A sign-in on a new device proves the login in the browser. The pinned prover needs a recent desktop Chromium with WebAssembly memory64 and several GB of memory, and the 12 November decision keeps proving in the browser: no token or witness goes to a server. So a phone, Firefox or Safari could not get a key onto an account at all.

The account has a second way to gain a key that needs no proof. `add_owner` (`../contracts/src/owners.cairo`) is called by the account itself, so by an existing owner, with the new key's signature over `new_owner_message_hash(account, anchor)`. The wallet sponsorship route already funds it (`../services/backend/src/services/recovery/wallet-sponsor.ts`). Only the keychain pages were missing. This change adds them. No contract, backend or SDK change is needed.

## The flow

Two devices, and two texts carried between them by the user (`src/link.ts`, `src/link-code.ts`):

1. **Signed-in device**, account page, "Add another device". The page makes a link, `/link#v=1&account=…&chain=…&class=…&id=…&exp=…`, and shows it to copy. `id` is 16 random bytes kept in that page only; `exp` is 15 minutes ahead.
2. **New device** opens the link. The keychain takes the link out of the address bar, checks the network, the account class and that the address is a deployed Kamui account, and shows the account with a warning. On "Create a key for this device" it makes a device key, reads the account's owners anchor, signs the acceptance message, and shows a code: `kamui-link1.<id>.<key>.<anchor>.<r>.<s>`, with a six-character check code derived from the key. The key and the code wait sealed in the vault (`pending-link`), so a reload keeps them.
3. **Signed-in device**: the user pastes the code. The page refuses it unless its `id` is this page's, the link has not run out, the key is not already an owner, the anchor is the account's current one, and the signature verifies for this account. It then shows the check code and asks for confirmation, and sends one `add_owner` through `/api/wallet/sponsor`, signed by this device.
4. **New device** looks at the account every few seconds. When the account lists its key, it stores the key as this device's and is signed in. If the anchor moves on without it, or the link runs out, it discards the key and says so.

What each text holds: the link, the account address, network, class and a random id; the code, a public key, an anchor and a signature. No private key, token, pepper or recovery file is in either. Both travel in a URL fragment or by copy and paste, and neither is sent to a Kamui server.

A device added this way never sees a sign-in, so it has **no pepper and no recovery file** (`AccountRecord.pepperFile` is now optional). Its account page says so and offers no download. The user keeps the recovery file from a device that signed in with the issuer.

Adding a key changes the owner set, so **every session ends**, as with any new device. The account holds at most five keys; a full account is told to remove one first, since `add_owner`, unlike recovery, does not replace the oldest.

## What can go wrong

- **Being talked into adding someone else's device.** This is the serious one: an owner key is full control. An attacker who gets a victim to paste the attacker's code and confirm owns the account. The link's `id` means a code made without the victim's link is refused, so the attacker must first be given the link; the pages say that Kamui never asks for this, that nobody helping needs the link or the code, and that the device being added must be in the user's hands and show the same check code. These are warnings and a speed bump, not a proof of proximity. The `id` check is made by the page, not by the contract: it protects a user of the honest page and nothing else.
- **A link sent to a victim.** Opening an attacker's link and creating a key would, once the attacker confirms, sign the victim's browser in to the attacker's account. The victim loses nothing they had, but could then fund or act from an account someone else also controls. The page names the account, warns against links from others, and refuses when the browser is already signed in to another account.
- **The link in transit.** The link reveals which account is the user's to whoever carries it (a messaging service, a clipboard manager). It grants nothing by itself.
- **A stale code.** The signature is bound to the anchor, so it cannot be replayed after any change of the owner set, on this or another account.
- **A compromised keychain origin** can already use the stored device key. This flow adds nothing to that.

## Options compared

| Option | Lets a new user start on a phone | Trust and privacy | Cost | Verdict |
|---|---|---|---|---|
| Device link from a signed-in device (this change) | No. Needs one desktop Chromium sign-in first | Nothing new leaves the browser. Adds a social-engineering surface | Keychain pages only | Done here, pending review and a real-phone run |
| Opt-in server or TEE proving | Yes | The server sees the token, the pepper and the witness: it can link the Google identity to the account, and a prover that also holds the relayer could recover for the user. Reverses the 12 November decision | Hosted prover, attestation or audit, abuse limits, a consent screen | Needs a decision by the wallet, security and privacy owners. Not built |
| Lighter prover | Yes, if it fits | Same as today | Upstream work: the V2 balance replay used about 3.2 GB of Wasm memory; iOS Safari has no memory64 | Track upstream. No date |
| Native prover in an app shell | Yes, per platform | Same as today, in native code | A native build of the prover and an SDK per platform | Later, with the native SDKs |

Recommendation: review and ship the device link, since it removes the "existing user cannot add a phone" half of the problem at no privacy cost; decide separately whether an opt-in remote prover is acceptable for first sign-up on a phone, because that is a change of trust model and not an engineering detail.

## Verified, and not

Verified, by `tests/link.spec.ts` and `link-code.test.ts`, against the fakes of `tests/fakes.ts` (whose `add_owner` checks the new key's signature as the contract does):

- the whole flow between two browser contexts, the second with memory64 turned off: no sign-in, pepper lookup, proof or relay on the new device, exactly one sponsored `add_owner`, and the new device then acting as an owner;
- refusals: a code for another link, a damaged code, a stale anchor, a declined confirmation, a full account, a link for another network, class or account, an expired or malformed link;
- the waiting key surviving a reload and being discarded on cancel.

Not verified:

- **iOS Safari, Android Chrome or any real phone.** The tests run desktop Chrome, and Playwright's desktop Firefox and WebKit builds when run locally. The flow uses only what a returning owner already needs (IndexedDB, WebCrypto, Stark signing, RPC reads), but nothing here shows a phone completing it. Storage limits such as Safari's ([SAFARI_STORAGE.md](SAFARI_STORAGE.md)) apply to the new key as to any other.
- **Sepolia.** No live `add_owner` was sent through the deployed sponsorship route by this flow.
- **A security review** of the warnings, the confirmation and the residual risks above.
- **Usability.** Moving a long link and a long code between devices by hand is clumsy. A QR code, or a short-lived relay, would help; each needs its own review (a relay is a new server recipient).

## Remaining for issue #16

A new user still cannot sign up on a phone, Firefox or Safari. That needs one of the other options in the table.
