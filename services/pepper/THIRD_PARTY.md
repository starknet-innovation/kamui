# Third-party code

## keep-starknet-strange/social-account (MIT)

From https://github.com/keep-starknet-strange/social-account at commit
`e1681348afbf5fc55ea410ea7ef93e1df575e969`.

Copied and modified:

- `src/jwt.ts`, from `backend/src/jwk/verification.ts` (`ISSUERS`, `fetchJwks`, `extractJwt`,
  `verifyJwt`, the `Jwk` and `Jwt` types). Changes: typed errors with HTTP statuses, type checks
  on each claim, an injectable clock and JWKS fetcher, a JWKS cache, `iat` and maximum-age
  checks, the audience allow-list check, a fetch timeout, and the issuer `variant` field dropped.

Copied unchanged, in a test only:

- `extractIdentity` in `test/identity.test.ts`, from `backend/src/social-account.ts`. The
  reference identity value in the same test is the one pinned in upstream's
  `backend/src/social-account.test.ts`.

Licence: MIT, Copyright (c) 2026 Keep Starknet Strange. The licence text is in
`licenses/social-account-LICENSE`.

Upstream states that this code is a proof of concept and not audited for production.

## Dependencies

- `@scure/starknet` 1.1.0 (MIT): Poseidon and Stark-curve signature verification, at run time.
- `starknet` 10.8.0 (MIT): tests only, for upstream's `extractIdentity`.
