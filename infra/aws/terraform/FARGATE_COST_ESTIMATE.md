> Superseded comparison, retained 12 November 2026. The selected target is now two EC2 servers with PostgreSQL on the backend server. See [current review](HOSTING_REVIEW.md) and [current estimate](COST_ESTIMATE.md).

# Open Sepolia beta: AWS planning estimate

Prepared 12 November 2026. USD, 730 hours/month, public On-Demand rates for Ireland (`eu-west-1`). **This is a proposed-stack estimate, not an observed bill, capacity test, approved budget or deployment authorization.** No AWS account was queried or changed.

The user selected the existing two test accounts, ECS/Fargate, Google-only public beta at `sepolia.kamui.page` and `pepper-sepolia.kamui.page`, Cloudflare DNS-only, AWS WAF at both public ALBs, a private API and migration to RDS PostgreSQL. Sponsorship is limited to approved apps, anonymous sponsorship off, with per-app/per-account/overall limits. These choices are not yet deployed; implementation and technical review remain pending in [HOSTING_REVIEW.md](HOSTING_REVIEW.md) and [HOSTING_ACCEPTANCE.md](HOSTING_ACCEPTANCE.md).

## Recommendation and scenarios

Recommend the small **Multi-AZ PostgreSQL instance deployment** and an initial **$400/month AWS planning target**, subject to the user's decision. This includes a 25% reserve above the baseline model. The reserve is a planning margin, not an enforced ceiling. The higher-usage scenario exceeds that target and would need a larger budget or reduced usage.

| Scenario | Fixed / month | Usage / month | Total / month | With 25% reserve |
|---|---:|---:|---:|---:|
| Baseline, Single-AZ DB | $245.22 | $33.58 | **$278.80** | $348.50 |
| Baseline, Multi-AZ DB | $272.58 | $33.58 | **$306.16** | $382.70 |
| Higher usage, Single-AZ DB | $245.22 | $160.83 | **$406.05** | $507.56 |
| Higher usage, Multi-AZ DB | $272.58 | $160.83 | **$433.41** | $541.76 |

Multi-AZ adds **$27.36/month** here, including instance and storage differences. It provides one synchronous standby; it does not make the whole application highly available. The model still has one API writer and one zonal NAT gateway per account. The database's size and burstable CPU behavior need workload validation. [RDS PostgreSQL pricing](https://aws.amazon.com/rds/postgresql/pricing/), [Multi-AZ instance deployments](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html)

## Baseline Multi-AZ breakdown

Amounts are rounded for display; totals use unrounded Decimal arithmetic. Quantities and each rate's SKU, rate code, publication date and public source URL are in the [rate snapshot](costs/rates-2026-11-12.json). The [calculated scenarios](costs/estimate-2026-11-12.json) retain every quantity and unrounded line amount.

| Item | USD / month |
|---|---:|
| Five Fargate tasks: 1.5 vCPU / 3 GiB combined | $54.06 |
| Two zonal NAT gateways | $70.08 |
| Two application load balancers | $36.79 |
| Six public IPv4 addresses (minimum modeled allocation) | $21.90 |
| PostgreSQL db.t4g.small (multi) | $50.37 |
| PostgreSQL 20 GB gp3 | $5.08 |
| Two WAF ACLs, five standard rules each | $20.00 |
| Six secret slots | $2.40 |
| Three customer-managed key resources (planning allowance) | $3.00 |
| 10 GB ECR image storage | $1.00 |
| One private DNS zone + two Cloud Map resources | $0.70 |
| 20 custom metrics + 12 standard alarms | $7.20 |
| ALB capacity: 1 LCU per ALB average (2 in higher scenario) | $11.68 |
| NAT data processing | $2.40 |
| Internet transfer out, billed allowance before free quotas | $9.00 |
| Cross-AZ/application traffic, combined billed GB units | $1.00 |
| WAF requests, across both ACLs | $0.60 |
| Standard logs, storage and CloudWatch API allowance | $3.88 |
| Billed RDS backup storage beyond included allowance | $1.90 |
| Secret retrieval API allowance | $0.50 |
| KMS API allowance | $0.30 |
| S3 audit/state storage + requests | $0.21 |
| Paid management-event copies + data-event allowance | $2.10 |
| Cloud Map discovery API allowance | $0.01 |
| RDS surplus CPU credits: zero assumed; unmeasured | $0.00 |
| **Total** | **$306.16** |

## Sizing and usage assumptions

- Five Linux x86 Fargate tasks: API 0.5 vCPU/1 GiB; keychain, pepper, rotator and watcher each 0.25 vCPU/0.5 GiB. Combined 1.5 vCPU/3 GiB. No hosted prover or hosted Ping demo. Startup/deployment overlap and later scaling consume the reserve or increase costs.
- Two public ALBs, each across two Availability Zones; two zonal NAT gateways, one per account. Minimum six public IPv4 addresses: four ALB and two NAT. Tasks and database have no public IP. More ALB addresses would add cost.
- RDS PostgreSQL `db.t4g.small`, 20 GB gp3. Compare Single-AZ with a Multi-AZ instance deployment, not a three-node readable cluster. Twenty GB of billed backup storage beyond the included allowance is modeled; this is not seven full daily copies. Backup retention and restore objectives still need a decision and validation.
- Two WAF ACLs with five billable standard rules each, within the base 1,500 WCU allowance. This prices a placeholder rule count, not a reviewed rule set. No premium Bot Control, CAPTCHA or Shield Advanced. Large proof requests and address handling need explicit testing.
- Six secret slots, three customer-managed KMS key resources, 10 GB ECR, one private DNS zone and two Cloud Map resources. The key allowance includes pepper and possible database/log keys; it neither approves creating keys nor measures existing keys, replicas or rotated versions. Twenty custom metrics and twelve standard alarms are allowances.
- Baseline usage: one average LCU per ALB, one million total WAF HTTP requests, 50 GB NAT processing, 100 GB billed internet egress, 100 combined billed cross-AZ GB units, 5 GB log ingestion and 1 GB retained logs. API allowances: 100,000 CloudWatch requests, 100,000 secret requests, 100,000 KMS requests and 10,000 Cloud Map requests.
- Small audit/state allowance: 5 GB S3, 10,000 PUTs, 100,000 GETs, 100,000 paid management-event copies and 100,000 data events. These are planning quantities, not measured account traffic or an audit-policy decision. Free quotas/credits are not deducted.
- Higher usage keeps the same task/database sizes but models two average LCUs per ALB, ten million WAF requests, 100 GB NAT, 1,000 GB internet egress, 200 combined billed cross-AZ GB units, 50 GB log ingestion and 5 GB retained logs. It is a cost sensitivity, not a throughput claim or expected tester count.

Browser asset delivery through the ALB is not also counted as NAT processing. NAT usage covers backend egress/image pulls. The two principal Wasm assets total 113,080,170 bytes before glue and compression. Current prover loading requests `cache: no-store` when verifying identity, so repeated proving can redownload the prover even with immutable server headers. Measure actual compressed transfer and cache behavior before relying on a download budget. Do not cache private witnesses or proofs as a cost optimization.

## Sensitivities and exclusions

Each extra 100 billed GB of internet egress adds $9.00 at the modeled tier; each million standard WAF requests adds $0.60 before any extra capacity/rule charges. RDS surplus CPU credits are assumed zero but unmeasured: 100 surplus vCPU-hours would add $7.50. The higher-usage model does not cover every possible peak or abuse event. WAF and AWS budget alerts do not establish an absolute spending cap; durable application debits, admission limits and an operator pause path remain required. The current in-memory sponsorship ledger does not satisfy restart-safe budgets.

Excluded: tax/VAT, exchange-rate effects, support plans and organization-wide security services, additional Regions/key replicas, RPC and AVNU vendor charges, test STRK funding, domain/Cloudflare plan charges, migration/engineering/audit labor, premium abuse controls, enhanced image scanning, larger databases, RDS Proxy and extra services. Standard non-exportable ACM certificates are assumed. No Savings Plans, reservations, negotiated discounts or credits are applied. Existing resources are priced in full, so this is not an incremental-cost estimate for SNF's actual bill.

Before deployment, the AWS owner must verify the existing pepper key's Region, regional service availability/quotas, payer and actual resource inventory. Wallet/security reviewers must review signer handling, app authorization and durable funding limits. Reviewers and an operator are still unassigned. AVNU's external spending controls and vendor costs remain unconfirmed.

## Reproduce and refresh

Run from the repository root:

```sh
python3 infra/aws/terraform/costs/estimate.py
```

The calculator uses only the committed snapshot, with Decimal arithmetic and no network or credentials. The snapshot was extracted from public AWS Price List catalogs on 12 November 2026. Sources are mutable `current` URLs; retained SKU/rate metadata records what this estimate used. Refresh rates and usage before deployment or a budget decision made materially later.

Primary references: [Fargate](https://aws.amazon.com/fargate/pricing/), [load balancers](https://aws.amazon.com/elasticloadbalancing/pricing/), [NAT and public IPv4](https://aws.amazon.com/vpc/pricing/), [WAF](https://aws.amazon.com/waf/pricing/), [RDS PostgreSQL](https://aws.amazon.com/rds/postgresql/pricing/), [Cloud Map](https://aws.amazon.com/cloud-map/pricing/) and [Route 53](https://aws.amazon.com/route53/pricing/). Use the regional catalog values in the snapshot rather than another Region's example prices on these pages.
