#!/usr/bin/env bash
# Sets up CLI access to the two Kamui TEST accounts of an AWS organization. Test setup only.
#
#   bash infra/aws/setup-test-access.sh [management-profile] [region]
#
# What it does, in the management account (default profile: snf):
#   - creates an IAM user `kamui-test-admin` whose only permission is to assume the
#     OrganizationAccountAccessRole of the accounts named kamui-pepper-test and
#     kamui-backend-test;
#   - creates an access key for it and stores it straight into the AWS CLI configuration.
# And locally: writes three CLI profiles, kamui-test-admin, kamui-pepper-test and
# kamui-backend-test.
#
# It prints no account id and no key. Run it once; a second run stops at "user already exists".
set -euo pipefail

MGMT=${1:-snf}
REGION=${2:-eu-west-1}
USER_NAME=kamui-test-admin
ROLE=OrganizationAccountAccessRole

account_id() {
  aws organizations list-accounts --profile "$MGMT" --query "Accounts[?Name=='$1'].Id | [0]" --output text
}

PEPPER_ID=$(account_id kamui-pepper-test)
BACKEND_ID=$(account_id kamui-backend-test)
for id in "$PEPPER_ID" "$BACKEND_ID"; do
  [[ "$id" =~ ^[0-9]{12}$ ]] || { echo "could not find both Kamui test accounts in the organization"; exit 1; }
done

if aws iam get-user --profile "$MGMT" --user-name "$USER_NAME" >/dev/null 2>&1; then
  echo "IAM user $USER_NAME already exists; nothing changed. Delete it first to start over."
  exit 1
fi

aws iam create-user --profile "$MGMT" --user-name "$USER_NAME" >/dev/null
aws iam put-user-policy --profile "$MGMT" --user-name "$USER_NAME" --policy-name assume-kamui-test-accounts \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRole\",\"Resource\":[\"arn:aws:iam::${PEPPER_ID}:role/${ROLE}\",\"arn:aws:iam::${BACKEND_ID}:role/${ROLE}\"]}]}"

# The key goes from AWS into the CLI configuration without being shown.
read -r KEY_ID SECRET <<<"$(aws iam create-access-key --profile "$MGMT" --user-name "$USER_NAME" \
  --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)"
aws configure set aws_access_key_id "$KEY_ID" --profile "$USER_NAME"
aws configure set aws_secret_access_key "$SECRET" --profile "$USER_NAME"
aws configure set region "$REGION" --profile "$USER_NAME"
unset KEY_ID SECRET

for pair in "kamui-pepper-test:$PEPPER_ID" "kamui-backend-test:$BACKEND_ID"; do
  profile=${pair%%:*}
  aws configure set role_arn "arn:aws:iam::${pair##*:}:role/${ROLE}" --profile "$profile"
  aws configure set source_profile "$USER_NAME" --profile "$profile"
  aws configure set region "$REGION" --profile "$profile"
done

echo "created IAM user $USER_NAME and profiles kamui-pepper-test, kamui-backend-test (region $REGION)"
echo "a new key can take a few seconds to work; then check with:"
echo "  aws sts get-caller-identity --profile kamui-pepper-test >/dev/null && echo pepper-ok"
echo "  aws sts get-caller-identity --profile kamui-backend-test >/dev/null && echo backend-ok"
