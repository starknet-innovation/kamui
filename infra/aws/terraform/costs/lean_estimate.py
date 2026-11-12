#!/usr/bin/env python3
"""Offline EC2/local-PostgreSQL planning model; no network or AWS access."""
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
import json
P = Path(__file__).resolve().parent
r = json.loads((P/'ec2-rates-2026-11-12.json').read_text())['rates']
old = json.loads((P/'rates-2026-11-12.json').read_text())['rates']
D = Decimal
money = lambda x: str(x.quantize(D('.01'), rounding=ROUND_HALF_UP))
result = {'region':'eu-west-1','checked_date':'2026-11-12','currency':'USD','month_hours':730,'scenarios':{}}
for name,backend in [('small_backend','t3.small'),('larger_backend','t3.medium')]:
    rows = [
        ('Backend EC2 including local PostgreSQL', D(r[backend]['usd'])*730),
        ('Pepper EC2 t3.micro', D(r['t3.micro']['usd'])*730),
        ('40 GB total gp3 volumes', D(r['gp3']['usd'])*40),
        ('Two public IPv4 addresses', D(old['ipv4_hour']['usd'])*2*730),
        ('Usage/backup/logging/secrets/KMS allowance (assumed, not measured)', D(20)),
    ]
    total = sum((v for _,v in rows),D(0))
    result['scenarios'][name] = {'backend_instance':backend,'rows':[{'name':n,'usd_exact':str(v),'usd':money(v)} for n,v in rows], 'monthly_usd':money(total),'with_25_percent_reserve_usd':money(total*D('1.25'))}
(P/'lean-estimate-2026-11-12.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
