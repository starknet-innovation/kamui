# Hosted Sepolia decisions — 12 November 2026

This record separates user choices from technical review and deployment authorization. It contains no AWS identifiers, credentials or private signing keys. A role/reference names the private review record; it must not paste private findings or resource values here.

| Topic | Recorded state | Recommendation / remaining decision |
|---|---|---|
| Audience and origins | Selected: open Google-only Sepolia beta at `sepolia.kamui.page` and `pepper-sepolia.kamui.page` | Preserve Google-only scope, client proving and existing account/registry addresses. Hosted Google acceptance remains pending. |
| Hosting | Selected: two existing separate AWS test accounts, Ireland, EC2 and local PostgreSQL | Start with reviewed 4 GiB backend / 1 GiB pepper sizes. Exact network/role/AMI choices require AWS owner review. |
| AWS planning budget | **User approved $100/month planning budget** | This is not a hard bill cap, funding/STRK limit or deployment approval. Retained data, WAL, egress and attack traffic can exceed the model. |
| Registry signer separation | **User selected a separate registry administrator with an operator-reviewed on-chain handoff** | **User selected off-server administration and manual updates**, with automatic independent watching. Subsequent custody choice: AWS KMS secp256k1 through a dedicated admin account; local implementation in [registry-admin](../../registry-admin/README.md), live Sepolia acceptance passed in run 13; custody/recovery review and role handoff remain pending. No administrator key or KMS signing identity is installed on the hosts. Effective KMS/STS/IAM permission isolation still requires review; the hosted relayer role check does not inspect it. Do not start the old shared API/rotator pair. |
| KMS custody/live evidence | Dedicated native k1 key created; real KMS signing, administrator deployment, validation-enabled estimates and Ping passed in [run 13](../../../../spikes/s1/results/run-13-kms-admin.md) | Run 13 supplies the exact immutable account class/full public key and a canonical accepted successful non-query V3 invoke. Recheck current controller/role state before signing; custody/recovery review remains required. Public RPC evidence does not attest AWS custody or future availability. |
| Registry recovery | **User selected sole KMS administrator and explicitly accepted loss-of-key risk on 12 November 2026** | No independent fallback is being prepared. Shared bootstrap and immutable-key loss remain documented limitations; effective permissions/custody and exact handoff review remain open. |
| Registry authority | Local source and live ABI use AccessControl; no `transfer_ownership` flow | Both `DEFAULT_ADMIN_ROLE` and `REVOKER_ROLE` must move. The admin role also permits upgrade; separate credentials alone do not make the rotator least-authority. |
| App funding | Selected: approved apps, anonymous off, explicit account/app/global limits; separate owner-authorized wallet funding implemented/default-off | Exact thresholds, app approvals, incident pause ownership and AVNU external controls remain to be reviewed. No nonzero hosted funding is approved by this record. |
| Backup/log retention | **User selected seven days for backups and operational logs, subject to SNF privacy review** | This does not prune unresolved recovery intents or the durable funding ledger. Confirm privacy acceptance, RPO/RTO, restore and diagnostic-log handling before enabling schedules. |
| Public boundary | Selected: Cloudflare DNS-only, direct HTTPS and private API/database | Security owner must accept the absence of upstream WAF/DoS filtering and independent public Wasm egress exposure, or revise/reprice the edge before public launch. |
| AWS/security/privacy/operator reviewers | **User is the AWS operator and security reviewer for this beta**; privacy/funding-specific evidence and real alert contact remain pending | Record private review evidence; the role assignment is not a completed technical approval. Do not substitute a filled checklist for a reviewer decision. |
| Stable address/DNS/OAuth ownership | Pending | Prefer one operator-managed stable public address per host; DNS and Google callback owners make the reviewed changes. |
| Deployment | **Requested; not performed** | AWS provisioning/security changes remain operator-run under the user’s standing rule. Reviewed resource selections, custody/recovery, DNS/OAuth, image digests and operational acceptance remain incomplete; no approval flags were inferred from the request. |

## Concrete review package

- [Ordered operator runbook](README.md) — image/network/host/Google sequence and explicit stop points.
- [Private read-only AWS inventory template](private-input.example.json) and [sanitized inspector](inspect_aws.py) — operator-run only; no AWS calls were made while preparing it.
- [Review record template](review.example.json) and [completeness checker](review.py) — records pending approvals without printing names/references or claiming security assurance.
- [Registry handoff preparation](registry_handoff.py) and [input template](handoff-input.example.json) — only public fields, explicit new-account class/full-key pins and canonical accepted controller-receipt evidence, read-only RPC and unsigned calls. No signing key input, private-key entry, broadcast or role transfer mode exists.
- [Public registry observation](public-registry-observation.json) — current ABI and role-admin observations, not proof of implementation equivalence, new signer custody or completed governance change.

## What the separate signer decision does not decide

The user subsequently selected a dedicated AWS KMS secp256k1 administrator account, with manual signing from the operator workstation. This is online KMS custody, not an air-gapped key. Its new account contract, AWS policy and independent recovery/governance require review before handoff. Hardware/offline control or a multisig was the earlier recommendation. Do not grant registry authority to a Kamui/social account whose recovery depends on this same registry; that would make recovery authority circular. The dedicated KMS key and separate Sepolia account now exist; this does not establish independent recovery or approve a role transfer.

The current `JwkRegistry` requires `DEFAULT_ADMIN_ROLE` for `set_key` and `upgrade`; `remove_key` needs `REVOKER_ROLE`. Its constructor grants both to the initial owner. Granting both to an online rotator makes that process an upgrade administrator. Keeping the administrator off-server means key additions/removals need an operator workflow and timely availability; it is not equivalent to an automatic rotator. A new limited role/governance contract design would be a separate security-sensitive change and is not silently included here. See [registry source](../../../../contracts/src/jwt/registry.cairo) and [revoker source](../../../../contracts/src/jwt/rec_aud_component.cairo).

Changing AccessControl roles on the existing registry does not require replacing its pinned address or changing the non-upgradeable account class. Do not deploy a replacement registry or change account derivation to avoid reviewing custody. The helper does not modify JWK material or audience/revocation state; verify those independently before and after the operator's handoff.


## Remaining execution gates

1. Completed: dedicated key creation and live KMS/Sepolia acceptance. Its reference stays private. The user removed Sepolia STRK caps before run 13; this does not approve registry authority changes, AWS provisioning/security changes or open-ended public sponsorship. Exact transaction reservations and no ambiguous resends still apply.
2. Review the immutable k1 admin implementation and operator-only effective KMS permissions, preserving the recorded sole-key risk acceptance; establish the live controller receipt and exact class/full public-key pins. No accepted security flags or evidence have been fabricated.
3. Prepare and review the exact grant batch; obtain authorization for the authority change after custody/recovery review. Sepolia STRK spending needs no further permission. After accepted grant, independently verify new custody/roles, prepare renunciation only with receipt proof and explicit operator acknowledgement, then sign and verify accepted success. No on-chain registry role was changed by preparation.
4. Keep hosted paid operation off until role handoff, actual AWS resource/policy review, private image digests, durable backup/restore, alert delivery, funding limits/app approvals and Google/DNS checks pass. User operator/security ownership and the $100 monthly planning figure do not replace those checks. Seven-day retention still requires privacy acceptance.

## Parallel follow-up — 12 November 2026

The user requested all three next steps in parallel. The current review packages are:

1. [Exact registry handoff review](HANDOFF_REVIEW-2026-11-12.md): fresh accepted Sepolia snapshot, class/full-key pins, canonical successful controller receipt and unsigned grants. Old relayer still has both roles; new KMS account has neither. Conditional renunciation remains blocked. Sole-key loss risk is now explicitly accepted; actual effective-permission/custody review remains unresolved.
2. [Ordered hosting execution](HOSTING_EXECUTION-2026-11-12.md): account-aware inventory, operator provisioning and host installation sequence. Resource selections, image digests and actual permissions must be supplied/reviewed privately; the older Terraform is not this lean design.
3. [Hosted beta acceptance](BETA_ACCEPTANCE-2026-11-12.md): executable fixed-origin public checks and ordered user-assisted Google/client-proving, sponsorship, restore and alert acceptance. Selected subdomains did not resolve during this follow-up, so live hosted checks cannot yet pass.

No registry authority changes, AWS provisioning/security changes, DNS or OAuth changes are claimed by these packages. No spending/security/privacy review flag is marked accepted. Sepolia STRK test spending does not need another permission request; ambiguous submissions still must be reconciled before another send.

### Sole-key decision recorded

The user answered the concrete recovery question: **“Sole KMS administrator; accept loss-of-key risk.”** No fallback account/key will be prepared. The `kms_admin_independent_recovery` evidence slot may reference this explicit risk-acceptance record, but must describe it as absence of independent recovery with accepted risk, not an independent-recovery test. Other evidence and actual reviewer acceptance fields remain unchanged. This decision does not approve a particular grant/renunciation batch or constitute an effective-permissions audit.

### Mainnet boundary

The user clarified that this KMS setup is acceptable **for Sepolia now**, while **mainnet requires a proper KMS setup**. The sole-administrator/shared-bootstrap risk acceptance is Sepolia-only and must not be reused as mainnet approval. Mainnet requires a separately reviewed custody/permission/recovery design, independently reviewed operator and host access, key disable/deletion/loss procedures, and contract/governance acceptance before any mainnet authority or funding. This records a future gate, not a claim that the current configuration satisfies it. Actual hosted role permissions and account-aware resource selections remain to be verified for the Sepolia deployment.
