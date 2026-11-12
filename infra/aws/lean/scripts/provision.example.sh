#!/bin/sh
# OPERATOR TEMPLATE ONLY. Do not run until the AWS owner approves the account-aware plan.
# This creates one paid instance using EXISTING reviewed network and instance-role objects.
# It does not create accounts, security groups, keys, policies or HMAC material.
set -eu
set +x
: "${AWS_PROFILE:?Existing account profile required}"
: "${KAMUI_ROLE:?backend or pepper}"
: "${AMI_ID:?Reviewed maintained x86 Linux AMI required}"
: "${SUBNET_ID:?Reviewed public subnet required}"
: "${SECURITY_GROUP_ID:?Reviewed existing group: only 80/443 public, no public database/API required}"
: "${INSTANCE_PROFILE_NAME:?Reviewed existing instance profile required}"
: "${ROOT_DEVICE_NAME:?Root device from reviewed AMI required}"
: "${OPERATOR_PRIVATE_DIRECTORY:?Private output directory required}"
[ "${KAMUI_INFRA_REVIEWED:-}" = yes ] || { printf '%s\n' 'INFRA_REVIEW_REQUIRED' >&2; exit 1; }
case "$KAMUI_ROLE" in backend) size=t3.medium; disk=30;; pepper) size=t3.micro; disk=10;; *) exit 1;; esac
umask 077
[ -d "$OPERATOR_PRIVATE_DIRECTORY" ] || exit 1
[ ! -e "$OPERATOR_PRIVATE_DIRECTORY/$KAMUI_ROLE-instance.json" ] || exit 1
[ ! -e "$OPERATOR_PRIVATE_DIRECTORY/$KAMUI_ROLE-provision.log" ] || exit 1
# Standard credits bound CPU-credit charges at the price of throttling; load-test before launch.
# Output includes sensitive resource metadata, so retain it privately rather than printing it.
if aws ec2 run-instances --profile "$AWS_PROFILE" --region eu-west-1 \
  --image-id "$AMI_ID" --instance-type "$size" --count 1 \
  --subnet-id "$SUBNET_ID" --security-group-ids "$SECURITY_GROUP_ID" --associate-public-ip-address \
  --iam-instance-profile "Name=$INSTANCE_PROFILE_NAME" \
  --metadata-options HttpTokens=required,HttpPutResponseHopLimit=2,HttpEndpoint=enabled \
  --credit-specification CpuCredits=standard \
  --block-device-mappings "DeviceName=$ROOT_DEVICE_NAME,Ebs={VolumeSize=$disk,VolumeType=gp3,Encrypted=true,DeleteOnTermination=false}" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Project,Value=kamui},{Key=Role,Value=$KAMUI_ROLE},{Key=Network,Value=sepolia}]" \
  > "$OPERATOR_PRIVATE_DIRECTORY/$KAMUI_ROLE-instance.json" 2> "$OPERATOR_PRIVATE_DIRECTORY/$KAMUI_ROLE-provision.log"; then
  :
else
  printf '%s\n' 'INSTANCE_PROVISION_FAILED_SEE_PRIVATE_LOG' >&2
  exit 1
fi
printf '%s\n' 'INSTANCE_RESULT_SAVED_PRIVATELY'
