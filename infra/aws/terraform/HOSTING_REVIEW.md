# Google-only Sepolia beta: lean hosting review

Updated 12 November 2026 against application baseline `0e98583`, plus the current wallet/manual-administration follow-up. **Design preparation only. No AWS resources, permissions, DNS or OAuth configuration changed. No deployment approval.** The user is the AWS operator and security reviewer for this beta; database/privacy/funding-specific evidence and alert contacts remain pending. Sensitive resource identifiers and credentials belong in private operator records.

## Selected direction

The user selected an open Google-only Sepolia beta at `sepolia.kamui.page` and `pepper-sepolia.kamui.page`, client-side proving, two existing separate AWS test accounts and Ireland for estimating. The latest cost decision supersedes ECS/Fargate and RDS: **use two small EC2 servers, with PostgreSQL on the backend server**. Cloudflare remains DNS-only. Direct HTTPS replaces the ALBs; NAT gateways, EFS, RDS and the previous ALB/WAF attachment are absent from this target. The lean package now supplies direct Caddy HTTPS, body/header limits, private service networks and application admission controls; effectiveness still needs review before public access. It does not provide an upstream WAF or guarantee protection against denial of service or asset-egress abuse.

Approved apps only may receive sponsorship, anonymous sponsorship is off, and explicit per-account/per-app/overall limits are required. Wallet deployment/recovery funding has separate limits. Private app-server authentication and durable count/FRI debits/pause are implemented. Owner-authorized self-management has its own wallet budget. Hosted thresholds/apps and AVNU external controls remain unapproved; the bounded run-12 policy is local testing only.

The [cost estimate](COST_ESTIMATE.md) models about $56/month with a 2 GiB backend or $72/month with 4 GiB. The implemented container limits leave insufficient verified OS/backup headroom on 2 GiB; use the user-selected 4 GiB / $100/month planning budget pending workload measurement. This is not a hard spending ceiling or deployment approval. The earlier [Fargate review](FARGATE_HOSTING_REVIEW.md) and [estimate](FARGATE_COST_ESTIMATE.md) are comparison material. Existing Terraform still describes the older Fargate/SQLite/EFS implementation and must not be applied as this design.

## Proposed topology

```mermaid
flowchart LR
    B[Browser: Google login and local proving] -->|HTTPS| H[Backend HTTPS proxy]
    subgraph Backend AWS test account
      H --> K[Keychain]
      K --> A[API: one writer]
      A --> P[Local PostgreSQL on encrypted EBS]
      W[Key watcher]
    end
    B -->|HTTPS| PH[Pepper HTTPS proxy]
    subgraph Pepper AWS test account
      PH --> S[Pepper service]
      S --> M[Existing KMS HMAC key]
    end
    A -->|HTTPS: authenticated deployment check| PH
    A --> V[Managed AVNU / Starknet RPC]
    O[Off-server registry administrator: manual updates] --> RPC[Starknet RPC]
    W --> RPC
    P --> BK[Private off-host database backups]
```

Selected initial sizing is x86 Linux `t3.medium` (4 GiB) for backend and `t3.micro` (1 GiB) for pepper, with 40 GB combined gp3 storage. Backend hosts keychain, one API process, PostgreSQL and watcher; pepper hosts only its HTTPS proxy and pepper application. No proving server or hosted demo is included. Benchmark resident memory and CPU credits before accepting sizing; `t3.small` (2 GiB) remains an unverified cheaper comparison. Burstable surplus CPU charges and deployment overlap are not measured.

Use a maintained HTTPS reverse proxy, such as Caddy, with automated certificate renewal. The API and database bind only to a local interface/private container network and have no public port. Keychain remains the API's only public route. Native services or separate containers must run under separate users; container volumes must survive replacement. Host compromise can cross these local boundaries: these are not separate machine trust domains.

## Review and implementation gates

| Decision | Selected or proposed direction | Remaining review |
|---|---|---|
| R1 Scope | Open Google-only Sepolia beta and selected subdomains | OAuth audience/callback, release protections and browser acceptance |
| R2 Placement | Two existing accounts; two EC2 servers; Ireland estimate | Actual key Region, profiles, permissions, encrypted volumes, maintenance and operator access |
| R3 Persistence | PostgreSQL on backend server | Migration, transactions, disk sizing, off-host backups and fenced restore |
| R4 Public boundary | DNS-only Cloudflare; HTTPS directly at each server; API/database local-only | Edge abuse controls, trusted proxy identity, TLS renewal, proof body sizes and origin exposure |
| R5 Release | Pinned client Wasm/proof profile; no server fallback | Reproducible production images, notices, hashes, browser memory/transfer and supported clients |
| R6 Signing | Pepper HMAC key unchanged; separate off-server registry administrator and manual updates selected | Complete operator-reviewed AccessControl role handoff before hosted API startup; new controller custody/independent recovery remains to be verified |
| R7 Spending | Approved apps, anonymous sponsorship off, explicit durable limits | App authentication, atomic debit/reconciliation, exact thresholds, AVNU controls and pause path |
| R8 Privacy | No sensitive request bodies in logs | Analytics/retention proposals and vendor/privacy review still undecided |
| R9 Operations | User-selected $100/month planning budget with 4 GiB backend; user is operator/security reviewer | Actual resource approval, privacy/retention, alerts, RPO/RTO and hosted acceptance remain pending |

EC2 instance profiles provide temporary AWS credentials; do not add long-lived AWS credentials to server files. Review per-process access to host role credentials: a backend instance profile does not isolate keychain from API or the backup consumer. The pepper role must remain limited to its intended KMS operations. Changing roles/key policies/security groups is an operator action after review. [EC2 roles](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/iam-roles-for-amazon-ec2.html)

Direct EC2 origins do not provide an AWS WAF association. Host/proxy rate limits, application admission, durable budgets and operator pause controls need an explicit reviewed design; they are not equivalent to managed WAF or upstream denial-of-service protection. If public exposure cannot be accepted under those controls, add a separately priced supported edge rather than claim the budget includes one. Cloudflare proxying is not silently enabled. [WAF supported resources](https://docs.aws.amazon.com/waf/latest/developerguide/how-aws-waf-works-resources.html)

The existing application must migrate from SQLite to PostgreSQL for recovery jobs and registry replay state. Preserve atomic admission, unique active-account locks, compare-and-swap journal transitions, nonce uniqueness and pruning. Add durable sponsorship/deployment funding state. Keep one API writer, including across releases; co-location does not fix shared signer nonces. Application adapters, explicit offline SQLite import, transaction tests and same-connection PostgreSQL writer fencing are now implemented locally; see [POSTGRESQL.md](../../../services/backend/POSTGRESQL.md). The existing developer databases were not migrated. Durable count/FRI spending counters and persisted pause are now implemented, with all paid operations initially off. Hosted cutover remains pending; the owner-authorized wallet route is implemented and default-off, pending hosted spending approval.

## Backup and recovery proposal

Local EBS persistence covers ordinary process/container restart; it does not replace backups or provide automatic database failover. Recommend off-host encrypted PostgreSQL base backups plus continuous WAL archiving, with backup failure/lag and disk-space alerts. Retention, RPO and RTO need decisions and measured restore evidence; no interval is promised here. Simple daily dumps alone can lose a day's journal history. Base backups plus a continuous WAL sequence support point-in-time recovery; logical dumps cannot substitute for that WAL base backup. [PostgreSQL recovery documentation](https://www.postgresql.org/docs/current/continuous-archiving.html)

**Restore fencing is required:** a restored snapshot may omit a paid transaction or consumed nonce. Keep admission, relaying, sponsorship and rotator writes stopped after restoring stale data. Reconcile the known signer transaction history and on-chain account state, retain uncertain locks, and rebuild conservative budget/replay state before resuming. If completeness cannot be established, remain paused for operator resolution. Never delete a lock or retry a payment merely because the restored database lacks its record.

Off-host backups must remain private and must not collect browser witnesses, JWTs, peppers or private proving state. Database backups may contain journal capabilities/replay metadata in protected forms and session display data; access and retention require review. Keep the existing HMAC key in KMS; do not add a key-material backup. Pepper export remains the user's separate recovery-file flow.

## Next implementation work

1. PostgreSQL stores, explicit SQLite import and durable funding counters are implemented locally. Review policy thresholds/app credentials before enabling any hosted funding; wallet funding is a separate operation with zero default limits.
2. Review the prepared [lean deployment package](../lean/README.md): separate host stacks, direct HTTPS, scoped secret files, stop-before-start releases, monitoring and operator-only provisioning. No cloud deployment is verified.
3. Backup/WAL archiving and host restore fencing are implemented; the disposable local base-backup plus WAL restore drill passed. Review retention, bucket/key/role controls, RPO/RTO and real alert delivery before hosted use.
4. Obtain AWS/security/operations review, then give the operator concrete provisioning/DNS commands. Hosted-origin acceptance remains in [HOSTING_ACCEPTANCE.md](HOSTING_ACCEPTANCE.md).

Application evidence: local Google existing-account recovery passed on Sepolia in run 11. That is not evidence for this hosting layout, first deployment, cloud restore or broader browser compatibility. No cloud capacity test, account-aware plan or deployment has run.

## Current governance and operator package

The [readiness package](../lean/readiness/README.md) records user decisions, a sanitized read-only AWS inspector and unsigned role/JWK planners. The registry uses AccessControl, not Ownable: key writes also require upgrade-admin authority. No administrator key belongs on the host. The hosted stack omits the rotator and its secret; the read-only watcher detects newly published Google keys absent from registry as well as event mismatches.

Removing the administrator mount is insufficient while the API relayer still has those roles. The lean API's mandatory `REQUIRE_OFFLINE_REGISTRY_ADMIN=true` gate checks the configured/actual Sepolia chain, fixed registry address and that the relayer has neither admin nor revoker role **before reading its signing key**. The current test relayer still requires the operator's grant-new → verify → renounce-old → verify handoff. This startup check is not a general custody audit or proof against later role drift. No role grant, renunciation, AWS inspection/provisioning, DNS or hosted deployment occurred here.
