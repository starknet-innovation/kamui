# Third-party code

## keep-starknet-strange/social-account (MIT)

Copied unchanged from https://github.com/keep-starknet-strange/social-account at commit
`e1681348afbf5fc55ea410ea7ef93e1df575e969`:

- `src/jwt.cairo`, `src/jwt/`
- `src/social.cairo`, `src/social/`
- `tests/data/`

Copied with the package name and the account contract name changed (`social_account` to `kamui`,
`SocialAccount` to `KamuiAccount`), so that upstream's tests run against the Kamui account:

- `tests/upstream_test_recover.cairo`
- `tests/upstream_test_prove_jwt.cairo`
- `tests/upstream_test_prover_executor.cairo`

Licence: MIT, Copyright (c) 2026 Keep Starknet Strange. The licence text is in
`licenses/social-account-LICENSE`.

Upstream states that this code is a proof of concept and not audited for production.

## OpenZeppelin Contracts for Cairo (MIT)

Used as a dependency at v4.0.1. `src/core.cairo` follows the structure of OpenZeppelin's
`SRC9Component` for the owner path of `execute_from_outside_v2`.
