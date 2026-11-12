#!/usr/bin/env python3
"""Check that an operator's review record is filled. Does not approve or deploy anything."""
import argparse
from decimal import Decimal, InvalidOperation
import json
import re

APPROVALS = {'aws', 'wallet_security', 'privacy', 'operations', 'funding'}
EVIDENCE = {'distinct_signer_ownership', 'funding_thresholds_and_app_approval',
            'external_paymaster_controls_or_local_transport', 'public_abuse_and_egress_review',
            'metadata_role_isolation', 'backup_repository_and_restore', 'alert_delivery',
            'stable_addresses_and_dns_owner', 'google_callback_owner', 'reviewed_image_digests_and_licenses', 'registry_admin_custody_and_rotation_availability',
            'kms_admin_operator_only_permissions','kms_admin_immutable_account_and_live_control',
            'kms_admin_independent_recovery','registry_handoff_verified'}
REF = re.compile(r'^[A-Za-z][A-Za-z0-9._/-]{0,119}$')


def reference(value):
    return isinstance(value, str) and bool(REF.fullmatch(value))


def check(record):
    if not isinstance(record, dict) or record.get('version') != 1 or record.get('selectedScope') != 'open-google-sepolia' or record.get('selectedRegion') != 'eu-west-1':
        raise ValueError()
    missing = []
    try:
        budget = Decimal(str(record.get('monthlyPlanningUsd')))
        if not budget.is_finite() or budget <= 0:
            raise InvalidOperation()
    except (InvalidOperation, ValueError):
        missing.append('monthly_planning_budget')
    # The selected package has no hosted administrator/rotator. A hot alternative
    # requires a new reviewed package, not a record-only acknowledgement.
    if record.get('registrySignerPlan') != 'separate_offserver_manual_rotation':
        missing.append('distinct_signer_plan')
    if record.get('registrySignerCustody') != 'kms_secp256k1_manual_operator':
        missing.append('kms_manual_operator_custody')
    for key in ['backupRetentionDays', 'logRetentionDays']:
        value = record.get(key)
        if type(value) is not int or not 1 <= value <= 3650:
            missing.append(key)
    approvals = record.get('approvals')
    evidence = record.get('evidence')
    if not isinstance(approvals, dict) or set(approvals) != APPROVALS or not isinstance(evidence, dict) or set(evidence) != EVIDENCE:
        raise ValueError()
    for name in sorted(APPROVALS):
        item = approvals[name]
        if not isinstance(item, dict) or item.get('accepted') is not True or not isinstance(item.get('owner'), str) or not item['owner'].strip() or len(item['owner']) > 120 or not reference(item.get('reference')):
            missing.append('approval_' + name)
    missing += ['evidence_' + name for name in sorted(EVIDENCE) if not reference(evidence[name])]
    return {'record_complete': not missing, 'missing': missing, 'deployment_executed': False,
            'note': 'HUMAN_REVIEW_RECORD_ONLY_NOT_SECURITY_ATTESTATION'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--record', required=True)
    options = parser.parse_args()
    try:
        with open(options.record) as source:
            record = json.load(source)
        report = check(record)
        print(json.dumps(report, sort_keys=True))
        return 0 if report['record_complete'] else 1
    except Exception:
        print('{"error":"REVIEW_RECORD_INVALID","deployment_executed":false}')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
