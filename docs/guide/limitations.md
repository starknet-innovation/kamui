# Status and limitations

Kamui is a **development preview**. Read this page before you plan a launch on it.

## Status

| | |
|---|---|
| Network | Starknet **Sepolia only**. No mainnet deployment. |
| Audit | **None**. Contracts, keychain, SDK and services are unaudited. Do not hold real funds. |
| Sign-in | **Google only**. Apple is implemented but not set up or tested live. |
| Hosted keychain | `https://sepolia.kamui.page` (beta). |
| API stability | Protocol version 1. Breaking changes are possible before a stable release. |

## Known limitations

### Integration

- **The SDK is not released on npm yet.** It builds as a package, and until the first release you install it from a file you build, see [Quickstart](/guide/quickstart#_1-add-the-sdk).
- **No wallet connectors.** No `starknet-react` connector, no get-starknet / wallet-standard support. Apps use the redirect helpers directly.
- **Redirects only.** Your page reloads on every connect and one-off approval. There is no popup or iframe mode.
- **One-off approvals fail on hosted Sepolia.** The keychain's `/execute` page posts the user's transaction to the sponsor endpoint without app credentials, and the hosted backend refuses it with `APP_AUTH_REQUIRED`.
- **No message signing API.** Sessions can sign SNIP-12 messages as the account on chain, but the SDK has no helper for it and the keychain has no `signMessage` request.
- **No native SDKs** and no mobile support. See [Native](/native/overview).

### Sponsorship

- **Approval is manual.** Ask the Kamui team for an app key and token. There is no dashboard, usage view or self-serve rotation.
- **Every sponsored call needs your server**, because the credential cannot be in the browser.

### Users

- **First sign-in on a device needs desktop Chromium.** The login proof is made in the browser and needs memory64 and several GB of memory. Firefox, Safari and mobile browsers cannot complete it today; there is no server fallback. Returning users on a device that already owns the account need no proof.
- **The first sign-in takes tens of seconds** while the proof runs.
- **Adding a device ends every session.** Your app is told by [`watchSession`](/guide/sessions#being-told-when-it-ends) (reason `owners-changed`), or sees `isConnectionAlive` turn false, and must ask again.
- **Safari may clear the keychain's storage** after seven days of Safari use without visiting it. The user then signs in as on a new device.
- **Referrer settings.** Browsers or extensions that strip referrers make the keychain refuse every request.
- **Only STRK and ETH are recognised** by name on approval screens. Other tokens are shown as unverified.
