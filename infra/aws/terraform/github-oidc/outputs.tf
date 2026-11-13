output "plan_role_arn" {
  description = "Set as the repository variable the plan workflow reads for this account."
  value       = aws_iam_role.plan.arn
}

output "apply_role_arn" {
  description = "Set as the repository variable the apply workflow reads for this account."
  value       = aws_iam_role.apply.arn
}

output "publish_role_arn" {
  description = "Empty in an account with no release registry."
  value       = length(var.release_repository_names) > 0 ? aws_iam_role.publish[0].arn : ""
}

output "oidc_provider_arn" {
  value = local.oidc_arn
}
