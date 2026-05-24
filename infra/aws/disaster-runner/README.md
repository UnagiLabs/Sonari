# Disaster Runner AWS Template

CloudFormation template for the disaster verifier runner on EC2 with Nitro Enclaves enabled.

The template creates:

- EC2 LaunchTemplate with `EnclaveOptions.Enabled: true`
- IAM role with read access to the runner, TEE signing, and Walrus Secrets Manager secrets
- ALB with HTTPS listener
- instance and ALB security groups
- CloudWatch Logs log group
- Auto Scaling Group pinned to one runner instance

Required parameters:

```txt
VpcId
SubnetIds
AcmCertificateArn
RunnerTokenSecretArn
TeeSigningKeySecretArn
WalrusConfigSecretArn
InstanceType
AmiId
```

Before production use, restrict `AllowedIngressCidr` to Cloudflare egress or an approved management range, confirm the selected instance type supports Nitro Enclaves, and bake or deploy the built runner artifact to `/opt/sonari/app`.

The template follows AWS CloudFormation's `AWS::EC2::LaunchTemplate EnclaveOptions` shape, where `Enabled: true` enables Nitro Enclaves for launched instances.
