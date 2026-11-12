# Lean Sepolia beta: AWS planning estimate

Updated 12 November 2026. The user selected **PostgreSQL on the backend EC2 server**, with a separate pepper EC2 server in its existing account. This supersedes the [Fargate/RDS comparison](FARGATE_COST_ESTIMATE.md). Two accounts, Ireland, Google-only, client proving and DNS-only Cloudflare remain the basis. No cloud action or budget approval.

## Monthly model

USD, 730 hours/month, Linux x86 On-Demand public rates. Backend `t3.small` (2 GiB), pepper `t3.micro` (1 GiB), 40 GB combined gp3, two public IPv4 addresses. Initial sizing is untested; database and application share backend memory and disk. No server proving.

| Item | USD/month |
|---|---:|
| Backend EC2 including local PostgreSQL | $16.64 |
| Pepper EC2 t3.micro | $8.32 |
| 40 GB total gp3 volumes | $3.52 |
| Two public IPv4 addresses | $7.30 |
| Usage/backup/logging/secrets/KMS allowance (assumed, not measured) | $20.00 |
| **Total** | **$55.79** |

The small-server model is **$69.73 with a 25% reserve**. The earlier **$75/month planning target** applies only if the small backend passes sizing tests. Current container memory limits total about 1,760 MiB before the OS and backup spikes, so the implementation now recommends the priced **4 GiB backend and a $100/month planning target** until a full-stack test demonstrates the smaller host is sufficient. Neither target is an approved ceiling. This is not a hard cap. A 4 GiB `t3.medium` backend raises the total to **$72.43**, or **$90.54 with reserve**. Do not accept the smaller server without testing PostgreSQL plus all resident services under load.

The **$20 allowance is an assumption**, covering modest billed egress, off-host backups, logs, monitoring, secrets and KMS usage/storage. It is not a separate itemized service quote or measured bill. Actual backup/WAL volume, asset egress, retention and telemetry may exceed it. The earlier model used 100 billed GB egress at $9/month; this leaves limited headroom within that allowance. Repeated browser proving may redownload large Wasm assets. No free quotas or credits are relied on.

## Changes and limits

No RDS, EFS, NAT gateway, ALB or ALB-associated WAF is included. HTTPS terminates directly on each server; the API and PostgreSQL remain local-only. Edge protection needs a replacement design and review before open access. Database maintenance, patching, backups and restore are now operator responsibilities; there is no automatic failover. See the [hosting review](HOSTING_REVIEW.md) for backup/WAL archiving and mandatory reconciliation after stale restores.

Excluded: tax/FX, support, RPC/AVNU vendor charges, test STRK, domain/Cloudflare plan, engineering/audits, additional managed edge services, surplus burstable CPU credits, extra disk/traffic and larger production workloads. Full server prices are modeled, not incremental SNF account spend. Disk snapshots/backups and their retention have not been measured. Adding edge services or additional monitoring requires repricing.

## Reproduce and sources

```sh
python3 infra/aws/terraform/costs/lean_estimate.py
```

The [EC2 rate snapshot](costs/ec2-rates-2026-11-12.json) includes selected public Ireland rates, SKU/rate codes and publication date. IPv4 pricing comes from the [original snapshot](costs/rates-2026-11-12.json). The [scenario output](costs/lean-estimate-2026-11-12.json) retains unrounded arithmetic. The calculator is offline and uses Decimal, without credentials or account access. Rates were checked 12 November 2026 using the [regional AWS catalog](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/eu-west-1/index.json); refresh before deployment. See also [EC2 pricing](https://aws.amazon.com/ec2/pricing/on-demand/), [EBS pricing](https://aws.amazon.com/ebs/pricing/) and [IPv4 pricing](https://aws.amazon.com/vpc/pricing/).
