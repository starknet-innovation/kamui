# Dedicated Sepolia network

`network.json` creates a new dedicated network inside each of the two **existing** test accounts. It neither adopts nor modifies any existing/default VPC or shared security group. The parent setup runner selects an available Ireland Availability Zone, supplies the host role, and saves all output identifiers privately. No cloud account, host, address allocation, NAT gateway, load balancer, KMS key or signing permission is created by this template.

## Runner contract

| Parameter | Input |
|---|---|
| `Role` | `backend` or `pepper` |
| `AvailabilityZone` | Available `eu-west-1` AZ pinned in private setup state |
| `VpcCidr` | Optional; fixed default `10.68.0.0/20` |
| `SubnetCidr` | Optional; fixed default `10.68.0.0/24` |

Outputs: `VpcId`, `SubnetId`, `SecurityGroupId`, `AvailabilityZone`. They have no CloudFormation exports. Stack status/output collection must finish successfully before filling the existing `aws-input.json` and starting the host launch sequence. The same RFC1918 range is deliberate because these accounts/networks are not interconnected; future peering requires a separately reviewed design.

The template creates exactly one IPv4 VPC, dedicated internet gateway/attachment, public subnet, route table/default route/association and web security group. Public address assignment is **off by default** on the subnet; the existing launch wrapper explicitly opts the single intended host into public addressing. The gateway attachment precedes the default route. [Subnet properties](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-ec2-subnet.html), [route properties](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-ec2-route.html).

The selected direct-origin beta requires public TCP **80/443** ingress, with no SSH, API, database or metrics ingress. Egress permits TCP **443** only for AWS APIs/SSM, S3, ACME, registries and HTTPS RPC. Return traffic is stateful. This is a newly created group, not a widening of a shared group. Security groups do not filter Amazon DNS/time sync or IMDS; host/container metadata credential isolation still needs its separate review. This template is not a WAF or DoS guarantee. [Security group behavior](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-groups.html), [explicit egress semantics](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-ec2-securitygroup.html).

## AMI and host preparation

The setup runner should resolve Amazon's **standard**, x86_64 AL2023 SSM parameter `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64`, then pin the returned image and verify it using `DescribeImages` with `Owners: ["amazon"]`. Persist the resolved image/publisher privately; do not repeat a moving `latest` lookup during a resumed launch. This template contains no AMI reference and does not launch an instance. [Amazon AL2023 launch guidance](https://docs.aws.amazon.com/linux/al2023/ug/ec2.html).

Do not infer Docker/Compose readiness merely from a valid image ID. Before the host stack starts, verify `python3`, systemd, Docker Engine and the `docker compose` v2 command using the reviewed host bootstrap. The selected standard AMI's SSM agent must be running and the host role/network must permit Session Manager access; no SSH fallback is opened. `sudo systemctl status amazon-ssm-agent` is the documented AL2023 status check. [SSM service commands](https://docs.aws.amazon.com/systems-manager/latest/userguide/ssm-agent-status-and-restart.html).

## Validation performed

Three offline tests check dedicated resource types, exact ports/egress, route dependency, addressing and private output contract, and reject widening/extra paid resources. The JSON template is 9,741 bytes, below the inline CloudFormation template limit. No AWS call or deployment occurred.

Both templates subsequently passed **cfn-lint 1.60.1**. `cfn-guard` is unavailable, so no cfn-guard compliance result is claimed. Account-aware CloudFormation service validation remains unperformed; the operator-run prepare phase calls `validate-template` before any create request. These layers are distinct from offline boundary tests and do not attest deployed security or readiness.
