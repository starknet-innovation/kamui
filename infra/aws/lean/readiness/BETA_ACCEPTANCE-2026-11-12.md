# Google-only hosted beta: execution and acceptance

12 November 2026, application baseline `2c0ec18`. The user requested deployment and hosted testing. The standing operator boundary keeps AWS provisioning/security changes user-run; requested execution also depends on the registry handoff/custody review, selected resource inputs, DNS and Google callback configuration. No cloud deployment or hosted login/proof is claimed here.

## What was checked now

- Read-only DNS lookups: `sepolia.kamui.page` and `pepper-sepolia.kamui.page` **do not resolve from this workstation**.
- Read-only HTTPS GETs: keychain `/live` and pepper `/health` **unavailable**. No response body or address was retained.
- Fixed-origin public checker: **six unit tests passed**, including changed Google/account pins, unwanted CSP sources, corrupt Wasm hashes, unexpected URL/redirects and exception-body privacy.
- The previously completed live run 13 proves the new KMS administrator can deploy and invoke on Sepolia. Registry roles have not moved; no hosted boot gate is bypassed.

The existing local runs 11/12 demonstrate Google client proving and durable PostgreSQL recovery, funding pause/replay and restart behavior. The local restore drill recovered replay rows, uncertain intents and funding state. Those checks do not establish the new HTTPS origins, AWS isolation, S3 restore, certificate issuance/renewal or delivery to real alert recipients.

## Ordered operator steps

1. Complete the concrete AWS/resource review and user-run provisioning sequence in [HOSTING_EXECUTION-2026-11-12.md](HOSTING_EXECUTION-2026-11-12.md). Preserve separate backend/pepper accounts, manual off-server KMS administration, one API writer, default-off paid operations and boot/restore fences. Use immutable reviewed image digests and the 4 GiB backend baseline. Do not apply the older Fargate Terraform as this layout.
2. Complete the separately reviewed registry handoff. Confirm both registry roles are removed from the API relayer before starting the lean API. The successful KMS Ping supplies live controller evidence; it does not decide independent recovery or authorize an unattended signing identity on the server.
3. In Cloudflare DNS, create **DNS-only** `A` records for `sepolia.kamui.page` and `pepper-sepolia.kamui.page` pointing to the matching operator-provisioned stable public host addresses. Add `AAAA` only if the hosts and reviewed ingress deliberately support IPv6. Keep addresses and AWS identifiers out of this record. This is a user-run DNS change; no proxy/edge feature is silently enabled. [Cloudflare record management](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/).
4. On the **existing intended Google OAuth web client**, add the exact authorized redirect URI `https://sepolia.kamui.page/callback`; add the JavaScript origin `https://sepolia.kamui.page` if that client's configuration requires it. Preserve local test callbacks if still needed. Verify public audience/consent/verification with the OAuth owner; changing origins does not approve a public launch or change the client ID. No Apple configuration is needed. [Google redirect URI setup](https://developers.google.com/identity/openid-connect/openid-connect#setredirecturi).
5. Set reviewed public production values: keychain origin above, pepper `https://pepper-sepolia.kamui.page`, public RPC, existing Kamui **user** class, existing registry and executor. Do not substitute the KMS admin class. Keep `APPLE_CLIENT_ID` absent. Private RPC/AVNU credentials stay API-side; no backend secret files are mounted into the keychain.
6. Let the operator's reviewed Caddy setup obtain certificates, verify renewal ownership/alarms and confirm the API/database have no public exposure. Start under the production host wrapper and verify the startup/restore gates and watcher. A public health response does not prove security-group or effective IAM isolation.
7. Run the read-only public checker below, then the supervised browser/operational steps. Keep hosted spending paused until the exact nonzero test policy is reviewed and loaded through the durable operator workflow.

## Public HTTPS acceptance command

From the repository root, first run the cheap availability probe:

```sh
python3 -B infra/aws/lean/readiness/hosted_acceptance.py --probe-only
```

Once available, set the **public** existing Google client ID and SHA-256 of `/main.js` from the matching reviewed release build. The hash must come from the reviewed image/build, not be trusted merely because the live server supplied it. Run:

```sh
python3 -B infra/aws/lean/readiness/hosted_acceptance.py \
  --google-client-id "$KAMUI_EXPECTED_PUBLIC_GOOGLE_CLIENT_ID" \
  --main-sha256 "$KAMUI_REVIEWED_MAIN_JS_SHA256" \
  --output "$KAMUI_PRIVATE_ACCEPTANCE_DIRECTORY/https-acceptance.json"
```

The output directory must already be an operator-owned mode `0700` absolute path outside Git. The result file is exclusive mode `0600`; never overwrite evidence. The full run downloads the pinned public prover assets (about **113 MB**, mostly two Wasm binaries), hashes streaming bytes, and retains no bodies or credentials. All requests are GET with normal TLS verification, fixed selected origins and no redirects. A green `probe-only` result is availability only. The full checker covers public headers/configuration/asset integrity, not the remaining host and wallet checks.

## Supervised browser and operation sequence

Use headed bundled Chromium and one persistent private test profile. Keep the profile, device key, recovery file and browser network trace private; do not record JWTs, peppers, proofs, bearer recovery IDs or transaction signatures in Git. No scripts automatically sign in or grant a session.

1. **Returning owner:** visit the hosted keychain, complete Google sign-in using the existing test identity when required, verify exact account/class and whether an existing hosted-origin owner skips proving. Localhost storage does not carry to the hosted origin. The current historical account already has **five device keys** after run 12: adding a new hosted-origin key requires an explicit old-device retirement choice or a separate test identity/account. Never remove a key silently or treat a full-owner-limit rejection as a proving failure.
2. **New-origin recovery:** after reviewing the key-slot plan, complete one Google sign-in, measure client V2 proof time/peak memory and confirm the accepted Sepolia transaction/account ownership. Verify no JWT/pepper/PIE/private execution is sent to a prover or RPC simulation, and no server fallback occurs. Expected Google/pepper/first-deployment authentication recipients need separate privacy review. Public checker results do not substitute for this trace.
3. **Device and recovery lifecycle:** reload, repeat returning-owner access, approve one clearly scoped Ping session in-page, Ping, revoke all and remove only an explicitly selected stale key while confirming a retained owner works. Test the exported recovery file with pepper stopped by the operator, then restore and verify pepper. Keep the recovery file private.
4. **Funding failure cases:** with a reviewed temporary nonzero policy, exercise pause, fresh-nonce exhausted budget, scope mismatch, duplicate nonce and response-loss reconciliation. A deliberately dropped response must retain its debit and reconcile the same hash; never submit another paid call merely because the UI lost the answer. Preserve PostgreSQL policy/debit state through API restart. Hosted funding currently remains default-off; local run-12 limits and the user's uncapped Sepolia wallet test allowance are not an approved public sponsorship policy.
5. **Operational acceptance:** verify real alert delivery to the operator using reviewed failure probes, monitor disk/backup/WAL lag and watcher mismatch/fetch failures. Perform a disposable off-host restore on operator resources with API admission fenced; measure RPO/RTO and reconcile unresolved intents/funding history before any release of the fence. Do not send fabricated successful alerts or infer S3 access from a local POSIX restore.
6. **Browser limits:** unsupported capabilities, token expiry, cancellation and memory failure must terminate workers and give a clear result without server proving. Safari storage deletion remains a separate naturally elapsed use-day test; do not wait seven days or claim a modeled deletion establishes it.

## Decisions and inputs still needed

| Item | Recommendation | Why execution waits |
|---|---|---|
| Recovery/key slots for hosted-origin Google test | Explicitly retire one known stale device while retaining a verified current owner; otherwise use a separate test identity | Historical account is at the five-key limit; the agent cannot choose which device to lose |
| Hosted funding policy | Begin paused; approve a small temporary authenticated test policy, then review open-beta account/app/global FRI/count ceilings | No nonzero hosted policy or externally enforceable AVNU ceiling has been selected |
| Alert recipient | Use the user as initial operator, with a separately reviewed delivery destination and a tested backup contact | Naming an operator alone does not configure or prove delivery |
| Backup/log retention and recovery target | Seven days as selected, subject to privacy review; measure an off-host restore before promising an RPO/RTO | No cloud restore or privacy approval is established by local drills |
| Public direct-origin abuse boundary | Explicitly review the existing direct HTTPS limits and Wasm egress exposure before opening access | Two EC2 hosts have no upstream WAF; the planning budget is not a spending cap |

The operator can prepare resource/DNS/OAuth steps while custody review proceeds. Keep public paid operations off and do not invent accepted review flags to start the API. Security/privacy/vendor claims remain for the appropriate reviewers.
