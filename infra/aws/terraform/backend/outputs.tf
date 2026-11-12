output "ecr_repository_urls" {
  description = "Push the three images here."
  value       = { for k, r in aws_ecr_repository.this : k => r.repository_url }
}

output "load_balancer_dns_name" {
  description = "Point the api's host name (the one on the certificate) at this."
  value       = module.alb.dns_name
}

output "secret_names" {
  description = "Secrets to fill in before deploy_services = true. Names only."
  value       = { for k, s in aws_secretsmanager_secret.this : k => s.name }
}

output "nat_public_ip" {
  description = "The address the backend's requests to the pepper service and the RPC come from."
  value       = module.network.nat_public_ip
}

output "log_groups" {
  value = {
    api     = module.api.log_group_name
    rotator = module.rotator.log_group_name
    prover  = module.prover.log_group_name
  }
}

output "internal_urls" {
  value = { prover = local.prover_url, rotator = local.rotator_url }
}
