# Google sign-in on a public test origin

The current live test flow remains Google-only. `kamui.page` is registered and its DNS is managed by Cloudflare. The user chose to retain the AWS-owner review path for hosting. No DNS record, certificate, cloud resource or OAuth setting was changed by this work.

For Sepolia testing, the proposed origin is `https://sepolia.kamui.page`. This proposal is not a deployed URL or a decision to use it as the production wallet origin.

## Application configuration

For the Google-only local UI, set `APPLE_CLIENT_ID` to an empty value; the existing Apple implementation remains available but its button is hidden. The current local keychain was restarted with that override.

The keychain accepts `KEYCHAIN_PUBLIC_ORIGIN=https://sepolia.kamui.page` and derives the callback `https://sepolia.kamui.page/callback`. The setting must be a bare HTTPS DNS origin, with no credentials, path, query or fragment. Without it, local development keeps `http://localhost:${PORT}/callback`. Request `Host` and forwarding headers never select the OAuth callback.

Use the existing Google OAuth client if the test should keep its existing `aud` and account identities. Add the exact HTTPS callback to that client's authorized redirect URIs; retain the localhost callback while local testing is needed. The pepper service must allow the HTTPS origin in `ALLOWED_ORIGINS`. Its Google audience allow-list, the backend's authorized Google client ID and the on-chain audience configuration must continue to agree. A different OAuth client, pepper or account class derives a different account.

## Hosting and DNS sequence for the operators

1. Review the hosting design with the AWS owner. The existing Terraform templates cover the backend and pepper, not public hosting of the keychain. Include the keychain build/serving path, HTTPS certificate, `/api` proxy, headers/CSP, public RPC configuration, secret handling, logs and deployment ownership in that review. The party serving the keychain can influence keys at sign-in; this is a security trust boundary.
2. Provision the reviewed HTTPS host and certificate through the approved process. Do not apply the existing test-account Terraform merely because a domain exists.
3. Once the host provides its actual DNS target, configure Cloudflare's `sepolia` record to that target. Do not invent a CNAME or point the wallet at a laptop's IP. Whether Cloudflare also proxies traffic is part of the hosting/security review.
4. Apply the application/OAuth origin settings above, restart or rebuild the keychain, and verify the exact callback and response security headers before a Google login.
5. Perform a Sepolia Google sign-in and recovery-file test on the HTTPS origin. Browser storage is scoped to the origin: it will not import the localhost device key. A first sign-in there adds a device key and ends existing sessions under D5.

No production hosting or permanent wallet-origin claim follows from these development changes. Apple setup and live testing are outside the current Google-only scope.
