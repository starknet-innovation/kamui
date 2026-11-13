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

# Credentials come from the environment of whoever runs Terraform. Apply this module with an
# administrative session, not from CI: it is what grants CI its access in the first place.
# allowed_account_ids makes Terraform stop if those credentials belong to another account.
provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = { project = "kamui", service = var.service, environment = var.environment, managed_by = "terraform" }
  }
}
