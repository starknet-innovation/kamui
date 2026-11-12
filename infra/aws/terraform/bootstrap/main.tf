# Creates the S3 bucket that holds Terraform state for ONE account. Apply it once per account
# (pepper test, backend test), with local state, before the account's root module:
#
#   terraform init
#   terraform apply -var aws_account_id=<account id> -var aws_region=<region> \
#                   -var state_bucket_name=<globally unique name>
#
# This module's own state stays on the machine that ran it (terraform.tfstate, ignored by
# ../.gitignore). It contains only the bucket's settings. Use a separate workspace or copy of
# this directory per account so the two local states do not overwrite each other.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0, < 7.0"
    }
  }
}

variable "aws_account_id" {
  description = "The account this must be applied in. Terraform refuses to run against any other."
  type        = string
}

variable "aws_region" {
  type = string
}

variable "state_bucket_name" {
  description = "Globally unique bucket name. Do not put the organisation's name in it."
  type        = string
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = { project = "kamui", environment = "test", managed_by = "terraform" }
  }
}

resource "aws_s3_bucket" "state" {
  bucket = var.state_bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "state" {
  statement {
    sid       = "DenyPlainHttp"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
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

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state.json
}

output "state_bucket_name" {
  value = aws_s3_bucket.state.bucket
}
