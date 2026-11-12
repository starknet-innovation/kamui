#!/usr/bin/env python3
"""Offline, deterministic scenario calculation from the committed public rate snapshot.

No network, account access, credentials or infrastructure changes. Usage quantities are
planning assumptions, not measurements, enforced limits or a capacity forecast.
"""
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parent
SNAPSHOT = json.loads((ROOT / 'rates-2026-11-12.json').read_text())
D = Decimal
RATES = SNAPSHOT['rates']

def money(value):
    return str(value.quantize(D('0.01'), rounding=ROUND_HALF_UP))

def scenario(availability, traffic):
    rows = []
    def add(name, category, **quantities):
        amounts = {key: D(str(qty)) * D(RATES[key]['usd']) for key, qty in quantities.items()}
        rows.append({'name': name, 'category': category, 'quantities': {k: str(v) for k, v in quantities.items()},
                     'usd_exact': str(sum(amounts.values(), D(0))), 'usd': money(sum(amounts.values(), D(0)))})
    high = traffic == 'higher'
    hours = 730
    add('Five Fargate tasks: 1.5 vCPU / 3 GiB combined', 'fixed', fargate_vcpu_hour=hours*D('1.5'), fargate_gib_hour=hours*3)
    add('Two zonal NAT gateways', 'fixed', nat_hour=hours*2)
    add('Two application load balancers', 'fixed', alb_hour=hours*2)
    add('Six public IPv4 addresses (minimum modeled allocation)', 'fixed', ipv4_hour=hours*6)
    add('PostgreSQL db.t4g.small (' + availability + ')', 'fixed', **{f'rds_{availability}_hour': hours})
    add('PostgreSQL 20 GB gp3', 'fixed', **{f'rds_{availability}_storage_gb_month': 20})
    add('Two WAF ACLs, five standard rules each', 'fixed', waf_acl_month=2, waf_rule_month=10)
    add('Six secret slots', 'fixed', secret_month=6)
    add('Three customer-managed key resources (planning allowance)', 'fixed', kms_key_month=3)
    add('10 GB ECR image storage', 'fixed', ecr_gb_month=10)
    add('One private DNS zone + two Cloud Map resources', 'fixed', private_zone_month=1, cloudmap_resource_month=2)
    add('20 custom metrics + 12 standard alarms', 'fixed', metric_month=20, alarm_month=12)
    add('ALB capacity: 1 LCU per ALB average (2 in higher scenario)', 'usage', alb_lcu_hour=hours*2*(2 if high else 1))
    add('NAT data processing', 'usage', nat_gb=100 if high else 50)
    add('Internet transfer out, billed allowance before free quotas', 'usage', internet_gb=1000 if high else 100)
    add('Cross-AZ/application traffic, combined billed GB units', 'usage', regional_gb=200 if high else 100)
    add('WAF requests, across both ACLs', 'usage', waf_request=10000000 if high else 1000000)
    add('Standard logs, storage and CloudWatch API allowance', 'usage', logs_ingest_gb=50 if high else 5, logs_stored_gb_month=5 if high else 1, cloudwatch_api_request=100000)
    add('Billed RDS backup storage beyond included allowance', 'usage', rds_excess_backup_gb_month=20)
    add('Secret retrieval API allowance', 'usage', secret_request=100000)
    add('KMS API allowance', 'usage', kms_request=100000)
    add('S3 audit/state storage + requests', 'usage', s3_gb_month=5, s3_put_request=10000, s3_get_request=100000)
    add('Paid management-event copies + data-event allowance', 'usage', cloudtrail_paid_management_event=100000, cloudtrail_data_event=100000)
    add('Cloud Map discovery API allowance', 'usage', cloudmap_api_request=10000)
    # Burstable CPU credits are a measured-workload sensitivity, not silently assumed away.
    add('RDS surplus CPU credits: zero assumed; unmeasured', 'usage', rds_cpu_credit_vcpu_hour=0)
    fixed = sum((D(r['usd_exact']) for r in rows if r['category']=='fixed'), D(0))
    usage = sum((D(r['usd_exact']) for r in rows if r['category']=='usage'), D(0))
    total = fixed + usage
    return {'availability': availability, 'traffic': traffic, 'rows': rows, 'fixed_usd': money(fixed), 'usage_usd': money(usage),
            'monthly_usd_exact': str(total), 'monthly_usd': money(total), 'with_25_percent_reserve_usd': money(total*D('1.25'))}

def main():
    scenarios = {f'{traffic}_{az}':scenario(az, traffic) for traffic in ['baseline','higher'] for az in ['single','multi']}
    delta = D(scenarios['baseline_multi']['monthly_usd_exact']) - D(scenarios['baseline_single']['monthly_usd_exact'])
    out = {'checked_date':SNAPSHOT['checked_date'], 'region':SNAPSHOT['region'], 'currency':'USD', 'month_hours':730,
           'no_account_access':True, 'scenarios':scenarios, 'multi_az_increment_usd':money(delta),
           'sensitivities':{'additional_100_billed_egress_gb_usd':money(D(100)*D(RATES['internet_gb']['usd'])),
             'additional_1m_standard_waf_requests_usd':money(D(1000000)*D(RATES['waf_request']['usd'])),
             'additional_100_rds_surplus_vcpu_hours_usd':money(D(100)*D(RATES['rds_cpu_credit_vcpu_hour']['usd']))}}
    (ROOT/'estimate-2026-11-12.json').write_text(json.dumps(out, indent=2)+'\n')
    for name,s in scenarios.items():print(f"{name}: fixed ${s['fixed_usd']}, usage ${s['usage_usd']}, total ${s['monthly_usd']}, with 25% reserve ${s['with_25_percent_reserve_usd']}")
    print('Multi-AZ increment: $'+out['multi_az_increment_usd'])
    for r in scenarios['baseline_multi']['rows']:print(f"{r['usd']:>7}  {r['name']}")

if __name__=='__main__':main()
