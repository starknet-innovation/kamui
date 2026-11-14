# Bounce page

How a native app asks the keychain for a session without weakening what the keychain checks: through a page on the app's own HTTPS domain.

::: warning Tested in the SDK, not on devices
The page and app helpers below are unit-tested in the SDK and the keychain accepts the request they build. The round trip has **not** been run on an iPhone or an Android device, and sign-in on a phone is still [blocked by the prover](/native/overview). Treat the platform notes as a design to verify, not as a supported flow.
:::

## Why a page, and not a custom scheme

The keychain cannot authenticate an app in a redirect. It binds a request to the site that sent it in two ways, and a native app breaks both:

- **The referrer.** The keychain refuses a request unless it came from a page on the origin of `redirectUri`. A page opened by an app has no referrer.
- **An `https:` return address.** The origin the user is shown is the origin the answer goes to, and only the owner of a domain can serve it. A custom scheme such as `mygame://` proves nothing: any app on the device can register it.

A page on your domain restores both. Your app opens the page; the page asks the keychain; the keychain sees and shows your domain.

## The flow

```
app            opens   https://mygame.example/kamui/start#kamui-native-start=…   (state, handoff key)
start page     creates the session key and sends the browser to the keychain
keychain       sign-in and approval, as on the web; shows mygame.example
return page    https://mygame.example/kamui/return#kamui=…  seals the answer to the handoff key
app link       https://mygame.example/kamui/app#kamui-native=…  handed to the app by the OS
app            opens the handoff with the key it kept, checks the chain, stores the session
```

1. The app makes a random **state** and a **handoff key** (P-256), keeps the private half, and opens the start page in the system browser with the state and the public half in the fragment.
2. The start page creates the **session key**, remembers the state and handoff key in `sessionStorage`, and navigates to the keychain with an ordinary [connect request](/reference/protocol#connect).
3. The user signs in and approves. The keychain redirects to the return page.
4. The return page reads the answer, **seals** the connection (session key included) to the handoff key, clears its storage, and navigates to the app link.
5. The OS hands the app link to the app. The app opens the handoff, checks the session on chain, and stores it in the Keychain or Keystore.

## What the link must never carry

The session key is made **in the page**, not in the app, and the scope is fixed **in the page's code**. This is the point of the design, not a detail.

Anyone can link to your start page. If the page took a session public key from its URL and forwarded it, an attacker could send a user a link with the attacker's key: the keychain would show your domain, the user would approve, and the attacker would hold a session on the user's account. That is the attack the referrer check exists to stop, moved one hop.

So the start link carries only a state and a transport key, and:

| A stranger's link with… | Result |
|---|---|
| their own handoff key | The connection is sealed to their key and sent to **your** app link. They never see it. Your app is not waiting for that state and drops it. |
| a guessed app link or return address | Ignored. Both are constants in your page. |
| a scope, limit or session key | Ignored. The page reads none of them. |

Rules for your page:

- Do not read `redirectUri`, the app link, the scope, limits or a session key from the URL, a query string or `postMessage`.
- The app link must be `https:` on a host your app is verified for. `finishNativeConnect` refuses anything else: the handoff carries the session key, and a custom scheme can be claimed by another app.
- Serve the page with the same care as a web integration: [send a referrer](/guide/quickstart#requirements-for-your-page), load no third-party script on these paths.

Rules for your app:

- One state and one handoff key per connect. Drop them when the handoff is opened or the browser is dismissed.
- Open only a handoff whose state is the one you made. `openNativeHandoff` enforces it.
- Check the session on chain (`isConnectionAlive`, or `get_session_data` on the account) before using it. Sealing is not signing: anyone who learned your handoff public key and state could seal a handoff of their own. Both travel only in the URL your app opens in the system browser, but the chain is the authority either way.

## The page

One script for both paths. The code is type-checked against the SDK in CI: [`docs/snippets/native`](https://github.com/starknet-innovation/kamui/tree/main/docs/snippets/native).

<<< @/snippets/native/bounce.ts

## The app

In TypeScript (React Native with a WebCrypto polyfill, untested):

<<< @/snippets/native/app.ts

In Swift or Kotlin you write the same four steps: make the state and key, build the start URL, receive the app link, open the handoff. The formats are below.

### Platform notes (not verified on devices)

- **iOS.** `ASWebAuthenticationSession` with an HTTPS callback (`Callback.https(host:path:)`, iOS 17.4+) for `mygame.example` and `/kamui/app`, with the domain associated with your app. Do not set `prefersEphemeralWebBrowserSession`: the user's device key lives in the browser's storage for the keychain, and an ephemeral session would start from nothing each time.
- **Android.** A Custom Tab for the start page and a verified App Link (`autoVerify`, `assetlinks.json`) for `/kamui/app`. Browsers may only hand a link to an app after a tap, which is why the return page shows a button as well as navigating.
- **Same-domain links.** Some browsers do not hand a link to an app when the page linking to it is on the same domain. If that stops the return, put the app link on a second host you verify for the app (for example `app.mygame.example`). The return page can use any `https:` app link; `redirectUri` must stay on the start page's origin.
- **App not installed.** `/kamui/app` then loads as a normal page. Serve something that says so. The fragment is sealed and useless to it.

## Formats

All values are base64url without padding unless noted.

### Start link

`{startPage}#kamui-native-start=<payload>`, where `<payload>` is this JSON, UTF-8, base64url:

```json
{ "v": 1, "state": "exhW7ejXf97Jjc8gvXfxR7UyxXLB_VDN", "key": "BA0wasNB…" }
```

| Field | Rule |
|---|---|
| `state` | 16 to 64 characters of `A-Z a-z 0-9 _ -`. At least 128 random bits. |
| `key` | The app's P-256 public key as an uncompressed point: 65 bytes, `0x04 ‖ x ‖ y`. |

### App link

`{appLink}#kamui-native=<payload>`, where `<payload>` is this JSON, UTF-8, base64url:

```json
{ "v": 1, "state": "exhW7ejX…", "epk": "BNAvv_Pj…", "iv": "9MIXhbkhyWlugwvu", "ct": "XxC6_T5V…" }
```

| Field | Meaning |
|---|---|
| `state` | The state from the start link. Refuse any other. |
| `epk` | The page's one-time P-256 public key, uncompressed, 65 bytes. |
| `iv` | 12 random bytes. |
| `ct` | AES-256-GCM ciphertext followed by the 16-byte tag. |

To open it:

1. `shared` = ECDH P-256 between the app's private key and `epk`: the 32-byte x coordinate.
2. `key` = HKDF-SHA256 with input `shared`, salt = `epk ‖ appPublicKey` (130 bytes, both uncompressed), info = the ASCII bytes of `kamui-native-handoff-v1`, 32 bytes out.
3. Decrypt `ct` with AES-256-GCM, nonce `iv`, additional data = the ASCII bytes of `state`.

CryptoKit (`P256.KeyAgreement`, `hkdfDerivedSymmetricKey`, `AES.GCM`) and the Java Cryptography Architecture (`ECDH`, `HmacSHA256`, `AES/GCM/NoPadding`) have every piece.

The plaintext is JSON:

```json
{ "ok": true, "connection": { "account": "0x…", "chainId": "0x534e5f5345504f4c4941", "classHash": "0x…",
    "session": { "privateKey": "0x…", "publicKey": "0x…", "validUntil": 1900000000, "maxCalls": 50 } } }
{ "ok": false, "error": "denied by the user" }
```

A sealed example with its key and plaintext, to check your decryption: [`sdk/test/vectors/native-handoff.json`](https://github.com/starknet-innovation/kamui/blob/main/sdk/test/vectors/native-handoff.json).

After that, sign calls with the session key: [Session signing](/reference/session-signing).

## What this does not solve

- **Sign-in on a phone.** Still blocked by the prover. A user who already signed in on that phone's browser can approve; a new one cannot.
- **Execute requests.** The page can use `beginExecute` and `finishExecute` as a web app does and pass the transaction hash to the app; there is no helper for it yet.
- **Apps without a domain.** There is no way to connect without an HTTPS domain you control. A registered app id that the keychain verifies some other way than by referrer is not designed yet.
