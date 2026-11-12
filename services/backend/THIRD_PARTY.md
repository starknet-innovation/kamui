# Third-party code

## keep-starknet-strange/social-account (MIT)

This folder started as a copy of `backend/` from
https://github.com/keep-starknet-strange/social-account at commit
`e1681348afbf5fc55ea410ea7ef93e1df575e969`. Licence: MIT, Copyright (c) 2026 Keep Starknet
Strange; the text is in `licenses/social-account-LICENSE`.

Unchanged from upstream: `src/jwk/`, `src/http.ts`, `src/env.ts`, `src/social-account.ts`,
`src/services/prover/`, `src/services/rotator/`, the Dockerfiles and the tests that came with
them.

Changed for Kamui (each change is marked `Kamui:` in the code):

- `src/services/recovery/pepper.ts` and its test are new: the pepper is confirmed with the
  pepper service before anything is paid for.
- `src/services/recovery/recover.ts`: calls that check; the request carries `keyProof`.
- `src/services/recovery/relay.ts`: reads the account's owners anchor (`get_owners_anchor`)
  where upstream read its single key (`get_public_key`).
- `src/services/recovery/deploy.ts`: `/deploy` is disabled when a pepper service is configured.
- `src/services/api/index.ts`: pepper settings, health output.
- `src/scripts/`: point at `contracts/` and the Kamui class; `declare-social-account.ts` is now
  `declare-account.ts`.
- `compose.yml`: the prover's memory cap is 20 GB instead of 8 GB.
- `deployments.env` replaces upstream's committed `.env` (this repository does not allow files named `.env`) and is loaded by `src/env.ts`. It holds the Kamui class hash; `SOCIAL_ACCOUNT_CLASS_HASH` is now `KAMUI_ACCOUNT_CLASS_HASH`.

Upstream states that this code is a proof of concept and not audited for production.
