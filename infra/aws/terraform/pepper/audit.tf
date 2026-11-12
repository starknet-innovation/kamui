# Audit of the pepper account: a CloudTrail trail that records every management event in every
# Region (KMS calls, including each GenerateMac, are management events), kept in S3 and copied
# to CloudWatch Logs, where metric filters turn the events that matter into alarms.
#
# For a test account this trail lives in the account it watches, so an administrator of the
# account can also stop it. Production: an organisation trail delivered to a separate log
# account (README, "Not for production as is").

data "aws_partition" "current" {}

locals {
  trail_name = "${var.name}-audit"
  trail_arn  = "arn:${data.aws_partition.current.partition}:cloudtrail:${var.aws_region}:${var.aws_account_id}:trail/${local.trail_name}"
}

# --- Storage -------------------------------------------------------------------------------

resource "aws_s3_bucket" "trail" {
  bucket_prefix = "${var.name}-audit-"
}

resource "aws_s3_bucket_versioning" "trail" {
  bucket = aws_s3_bucket.trail.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "trail" {
  bucket                  = aws_s3_bucket.trail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "trail_bucket" {
  statement {
    sid       = "CloudTrailChecksTheBucket"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.trail.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }

  statement {
    sid       = "CloudTrailWritesLogs"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.trail.arn}/AWSLogs/${var.aws_account_id}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }

  statement {
    sid       = "DenyPlainHttp"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.trail.arn, "${aws_s3_bucket.trail.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "trail" {
  bucket = aws_s3_bucket.trail.id
  policy = data.aws_iam_policy_document.trail_bucket.json
}

resource "aws_cloudwatch_log_group" "trail" {
  name              = "/kamui/${var.name}/cloudtrail"
  retention_in_days = var.trail_log_retention_days
}

data "aws_iam_policy_document" "trail_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "trail_to_logs" {
  name               = "${var.name}-cloudtrail-to-logs"
  assume_role_policy = data.aws_iam_policy_document.trail_assume.json
}

data "aws_iam_policy_document" "trail_to_logs" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.trail.arn}:*"]
  }
}

resource "aws_iam_role_policy" "trail_to_logs" {
  name   = "write-trail-logs"
  role   = aws_iam_role.trail_to_logs.id
  policy = data.aws_iam_policy_document.trail_to_logs.json
}

# --- The trail -----------------------------------------------------------------------------

resource "aws_cloudtrail" "audit" {
  name                          = local.trail_name
  s3_bucket_name                = aws_s3_bucket.trail.id
  is_multi_region_trail         = true # replicas of the key live in other Regions
  include_global_service_events = true
  enable_log_file_validation    = true
  cloud_watch_logs_group_arn    = "${aws_cloudwatch_log_group.trail.arn}:*"
  cloud_watch_logs_role_arn     = aws_iam_role.trail_to_logs.arn

  # The default event selector is used: all management events, read and write, with KMS events
  # NOT excluded. Do not add an event selector that excludes kms.amazonaws.com: key use would
  # stop being recorded.

  depends_on = [aws_s3_bucket_policy.trail, aws_iam_role_policy.trail_to_logs]
}

# --- Alarms --------------------------------------------------------------------------------

resource "aws_sns_topic" "alarms" {
  name = "${var.name}-key-alarms"
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  metric_namespace = "Kamui/PepperKey"

  # CloudWatch Logs filter patterns over CloudTrail records.
  key_filters = {
    # Any attempt, allowed or denied, to delete or disable a key, or to change who can use
    # one: the policy, grants, the primary Region, or the trail that records all this.
    KeyTamperingAttempts = <<-EOT
      { (($.eventSource = "kms.amazonaws.com") && (($.eventName = "ScheduleKeyDeletion") || ($.eventName = "DisableKey") || ($.eventName = "PutKeyPolicy") || ($.eventName = "CreateGrant") || ($.eventName = "UpdatePrimaryRegion") || ($.eventName = "DeleteImportedKeyMaterial"))) || (($.eventSource = "cloudtrail.amazonaws.com") && (($.eventName = "StopLogging") || ($.eventName = "DeleteTrail") || ($.eventName = "UpdateTrail") || ($.eventName = "PutEventSelectors"))) }
    EOT

    # A MAC requested by anything other than the service's role, allowed or denied.
    MacByOtherPrincipal = <<-EOT
      { ($.eventSource = "kms.amazonaws.com") && (($.eventName = "GenerateMac") || ($.eventName = "VerifyMac")) && ($.userIdentity.sessionContext.sessionIssuer.arn != "${module.service.task_role_arn}") }
    EOT

    # Every MAC request, for the volume alarm.
    MacCalls = <<-EOT
      { ($.eventSource = "kms.amazonaws.com") && ($.eventName = "GenerateMac") }
    EOT
  }
}

resource "aws_cloudwatch_log_metric_filter" "key" {
  for_each       = local.key_filters
  name           = each.key
  log_group_name = aws_cloudwatch_log_group.trail.name
  pattern        = trimspace(each.value)

  metric_transformation {
    name          = each.key
    namespace     = local.metric_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "key_tampering" {
  alarm_name          = "${var.name}-key-tampering-attempt"
  alarm_description   = "Someone tried to delete, disable or re-permission a KMS key, or to stop the audit trail, in the pepper account."
  namespace           = local.metric_namespace
  metric_name         = aws_cloudwatch_log_metric_filter.key["KeyTamperingAttempts"].metric_transformation[0].name
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "mac_by_other" {
  alarm_name          = "${var.name}-mac-by-other-principal"
  alarm_description   = "GenerateMac or VerifyMac was called by something other than the pepper service's role."
  namespace           = local.metric_namespace
  metric_name         = aws_cloudwatch_log_metric_filter.key["MacByOtherPrincipal"].metric_transformation[0].name
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "mac_volume" {
  alarm_name          = "${var.name}-mac-volume"
  alarm_description   = "Unusual number of GenerateMac calls on the pepper key."
  namespace           = local.metric_namespace
  metric_name         = aws_cloudwatch_log_metric_filter.key["MacCalls"].metric_transformation[0].name
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.generate_mac_alarm_threshold
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}
