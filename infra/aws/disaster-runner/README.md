# Disaster Runner AWS Template

Nitro Enclaves を有効化した EC2 上で disaster verifier runner を動かすための CloudFormation template です。

この template は次のリソースを作成します。

- `EnclaveOptions.Enabled: true` を持つ EC2 LaunchTemplate
- runner token、TEE signing key、Walrus 設定の Secrets Manager secret を読める IAM role
- HTTPS listener 付き ALB
- instance / ALB 用 security group
- CloudWatch Logs log group
- runner instance 1 台に固定した Auto Scaling Group

必須 parameter:

```txt
VpcId
SubnetIds
AcmCertificateArn
RunnerTokenSecretArn
TeeSigningKeySecretArn
WalrusConfigSecretArn
NitroEnclaveProcessCommand
WalrusAggregatorUrl
InstanceType
AmiId
```

`NitroEnclaveProcessCommand` は `RUNNER_BACKEND=aws` で使う executable path です。request を enclave に転送する host 側 command を渡してください。`WalrusAggregatorUrl` は TEE process 向けに `SONARI_WALRUS_AGGREGATOR_URL` として注入されます。

本番利用前に、`AllowedIngressCidr` を Cloudflare egress または承認済み management range に制限してください。また、選択した instance type が Nitro Enclaves をサポートしていることを確認し、build 済み runner artifact を `/opt/sonari/app` に bake または deploy してください。

bootstrap script は `/opt/sonari/runner-token`、`/opt/sonari/tee-signing-key`、`/opt/sonari/walrus-config.json` を `ec2-user:ec2-user` 所有、`0400` permission で作成します。systemd service は `ec2-user` として実行されるため、この ownership が必要です。

この template は AWS CloudFormation の `AWS::EC2::LaunchTemplate EnclaveOptions` 形式に従います。`Enabled: true` により、起動される instance で Nitro Enclaves が有効になります。
