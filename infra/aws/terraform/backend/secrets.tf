# The backend's secrets, as Secrets Manager secrets. Terraform creates the secrets EMPTY. Their
# values are put in once, outside Terraform (README, runbook step 6), so no private key ever
# appears in a .tf file, a variable, a plan or the Terraform state.
#
# Each service's execution role can read only the secrets listed for that service (main.tf):
# the rotator cannot read the relayer key, the prover can read only the RPC URL.

locals {
  secrets = {
    relayer-private-key        = "Relayer account private key: pays for deployments and recoveries. Read by the api."
    prover-account-private-key = "Prover account private key: signs the virtual prove_jwt transaction. Never funded. Read by the api."
    owner-private-key          = "Registry owner private key: signs key rotations. Read by the rotator."
    rpc-url                    = "Starknet RPC URL. Kept as a secret because providers put an API key in it. Read by all three services."
  }
}

resource "aws_secretsmanager_secret" "this" {
  for_each                = local.secrets
  name                    = "${var.name}/${each.key}"
  description             = each.value
  recovery_window_in_days = var.secret_recovery_window_days
  # Encrypted with the account's AWS managed key for Secrets Manager (no kms_key_id), so the
  # execution roles need no KMS permission.
}

# No aws_secretsmanager_secret_version resource, on purpose.
