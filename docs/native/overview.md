# Native integration

Kamui is built for the web first. This page sets out how native apps (iOS, Android, React Native, Capacitor, game engines) will connect, and **what is missing today**. None of these flows is supported yet.

::: danger Not supported yet
The blocker is sign-in on phones: a user's first sign-in on a device makes a zero-knowledge proof in the browser, and that prover needs a recent **desktop Chromium** with memory64 and several GB of memory. Mobile Safari and mobile Chrome cannot do it today, and there is no server fallback. A user who has never signed in on that phone cannot complete the flow by signing in there.

The keychain now has a second way in that needs no proof: a user who is signed in on a desktop can add another device from the account page (a link to open on the new device, a code to paste back). It has not been run on a phone yet, so it is not a supported path, and it does not help a user who has no desktop sign-in.
:::

## Connection flows

### Browser-based sessions

The same flow as on the web, through the system browser:

1. The app generates a session key pair and keeps the private key in the Keychain (iOS) or Keystore-backed storage (Android).
2. It opens a page **on the app's own HTTPS domain** in an `ASWebAuthenticationSession` (iOS) or a Custom Tab (Android). That page builds the [connect request](/reference/protocol) and navigates to the keychain, so the keychain sees the app's origin as referrer.
3. The user signs in and approves the session.
4. The keychain redirects to `redirectUri` on the same HTTPS domain, configured as a **universal link** (iOS 17.4+ `ASWebAuthenticationSession` HTTPS callbacks) or an **App Link** (Android). The answer is in the URL fragment.
5. The app reads the answer, then signs session calls itself and sends them to your [sponsor route](/guide/sponsorship).

Status and gaps:

| Need | Today |
|---|---|
| Sign-in on a phone the user has not used before | **Blocked**: browser prover is desktop Chromium only |
| Adding a phone from a desktop that is signed in | In the keychain, **untested on phones** |
| Custom URL schemes (`mygame://kamui`) as `redirectUri` | **Refused**. Only `https:` (or `http://localhost`) |
| Opening the keychain URL directly from the app | **Refused**: no referrer. Needs a bounce page on your domain |
| Native session signing (Swift, Kotlin, Rust, C#) | **No SDK**. You implement Stark ECDSA, the SNIP-12 outside-execution hash and Kamui's session signature yourself (see [Protocol](/reference/protocol#signing-session-calls)) |
| React Native | The TypeScript SDK may work with `starknet` polyfills (`crypto.getRandomValues`); **untested** |

### Web wrapper (Capacitor)

An existing Kamui web app packaged in a native shell, using the browser-based flow above with deep-link return. Same blockers: phone sign-in, and HTTPS-only redirects (Capacitor's `capacitor://localhost` or `https://localhost` origins are not your domain, so the return must go through a universal or App Link).

### Headless (app-managed keys)

**Not planned for Kamui accounts.** Every Kamui account is owned by a person who signed in with Google, and a session needs that person's approval. A server acting for a user should use a session approved once in a browser: see [Node.js](/examples/node).

## Choosing a flow

| Use case | Flow | Today |
|---|---|---|
| Web game or dapp | Web redirects | Supported: [React](/examples/react), [Svelte](/examples/svelte) |
| Game backend, bot, script acting for a user | Session approved in a browser, used from a server | Supported: [Node.js](/examples/node) |
| Mobile game | Browser-based session | Not yet |
| Existing web app in a native shell | Web wrapper (Capacitor) | Not yet |
| Desktop game (Unity, Godot, native) | Browser-based session with a localhost callback | Possible with the [Node.js pattern](/examples/node) on desktop, but no SDK in those languages |

## Desktop apps today

A desktop app can use the same localhost round trip as the [Node.js example](/examples/node): serve `/start` and `/callback` on `http://localhost:<port>`, open `/start` in the system browser, and read the answer posted back. The user's desktop browser handles sign-in, so the prover requirement is met on desktop Chromium. You still need session signing in your language, see the [protocol](/reference/protocol#signing-session-calls).
