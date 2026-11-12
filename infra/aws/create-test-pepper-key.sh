#!/usr/bin/env bash
# Creates the TEST pepper key in AWS KMS and points the local pepper service at it.
#
#   bash infra/aws/create-test-pepper-key.sh [profile] [region]
#
# In the account behind the profile (default: kamui-pepper-test) it creates one multi-Region
# HMAC_256 key whose material KMS generates, with the alias alias/kamui-pepper-test.
# Locally it writes services/pepper/.env.local (gitignored) with the key's ARN and its key
# check value, so `bun run src/index.ts` in services/pepper uses KMS.
#
# It prints the key check value (16 characters, safe to share) and whether the key is
# multi-Region. It does not print the ARN or the account id.
#
# TEST ONLY. The production key needs the guardrails in services/pepper/DESIGN.md section 13
# before anything depends on it.
set -euo pipefail

PROFILE=${1:-kamui-pepper-test}
REGION=${2:-$(aws configure get region --profile "$PROFILE" || echo eu-west-1)}
ALIAS=alias/kamui-pepper-test
HERE=$(cd "$(dirname "$0")" && pwd)
SERVICE="$HERE/../../services/pepper"
ENV_FILE="$SERVICE/.env.local"
BUN=${BUN:-$(command -v "$HERE/../../spikes/s1/tools/node_modules/.bin/bun" || command -v bun)}

if aws kms describe-key --profile "$PROFILE" --region "$REGION" --key-id "$ALIAS" >/dev/null 2>&1; then
  echo "$ALIAS already exists in this account and Region; nothing created."
  ARN=$(aws kms describe-key --profile "$PROFILE" --region "$REGION" --key-id "$ALIAS" --query KeyMetadata.Arn --output text)
else
  ARN=$(aws kms create-key --profile "$PROFILE" --region "$REGION" \
    --key-spec HMAC_256 --key-usage GENERATE_VERIFY_MAC --multi-region \
    --description "Kamui pepper key (TEST). HMAC-SHA-256 over issuer and user id." \
    --query KeyMetadata.Arn --output text)
  aws kms create-alias --profile "$PROFILE" --region "$REGION" --alias-name "$ALIAS" --target-key-id "$ARN"
  echo "created the key and $ALIAS"
fi

MULTI=$(aws kms describe-key --profile "$PROFILE" --region "$REGION" --key-id "$ARN" --query KeyMetadata.MultiRegion --output text)

# The key check value, computed by the service itself through KMS.
CHECK=$(cd "$SERVICE" && AWS_PROFILE="$PROFILE" PEPPER_KEY_SOURCE=kms KMS_KEY_ID="$ARN" "$BUN" run src/index.ts --print-key-check | tail -1)
[[ "$CHECK" =~ ^[0-9a-f]{16}$ ]] || { echo "could not compute the key check value"; exit 1; }

umask 077
cat > "$ENV_FILE" <<ENV
# Written by infra/aws/create-test-pepper-key.sh. TEST key. Not committed.
PEPPER_KEY_SOURCE=kms
KMS_KEY_ID=$ARN
PEPPER_KEY_CHECK=$CHECK
PEPPER_KEY_VERSION=1
ENV

echo "multi-Region: $MULTI"
echo "key check value: $CHECK"
echo "wrote services/pepper/.env.local"
