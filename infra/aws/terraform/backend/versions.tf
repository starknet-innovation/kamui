terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0, < 7.0"
    }
  }

  # Settings come from a file that is not committed:
  #   terraform init -backend-config=backend.hcl      (see backend.hcl.example)
  backend "s3" {}
}

# Credentials come from the environment of whoever runs Terraform (see the README, "State and
# credentials"). allowed_account_ids makes Terraform stop if those credentials belong to any
# account other than the backend test account.
provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = { project = "kamui", service = "backend", environment = var.environment, managed_by = "terraform" }
  }
}
