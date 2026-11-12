output "ecr_repository_url" {
  description = "Push the pepper image here."
  value       = aws_ecr_repository.pepper.repository_url
}

output "load_balancer_dns_name" {
  description = "Point the service's host name (the one on the certificate) at this."
  value       = module.alb.dns_name
}

output "task_role_arn" {
  description = "The only principal the key policy lets call GenerateMac."
  value       = module.service.task_role_arn
}

output "log_group" {
  value = module.service.log_group_name
}

output "nat_public_ip" {
  value = module.network.nat_public_ip
}

output "alarm_topic_arn" {
  value = aws_sns_topic.alarms.arn
}

output "key_policy_json" {
  description = "The key policy from kms.tf, rendered, for review. Applied only when manage_key_policy = true."
  value       = data.aws_iam_policy_document.pepper_key.json
}
