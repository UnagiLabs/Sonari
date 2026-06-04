# Maintenance runbook

この runbook は古い AWS 側 file cleanup、cost/resource 確認、rollback を扱います。

## 古い AWS 側 file cleanup

新 stack の smoke が成功し、resource inventory で idle が確認できた後にだけ、古い AWS 側 file を削除します。cleanup 対象は、古い S3 prefix、古い Lambda zip object、古い TEE tarball object、古い EIF object、古い SHA object です。旧単独 earthquake runner stack と GitHub environment は統合 runner への移行後に削除します。

```bash
aws s3 ls "s3://$ARTIFACT_BUCKET/earthquake-runner/" --recursive > /tmp/old-earthquake-runner-s3-before.txt
aws s3 ls "s3://$ARTIFACT_BUCKET/membership-identity-runner/" --recursive > /tmp/old-membership-identity-runner-s3-before.txt

aws s3 rm "s3://$ARTIFACT_BUCKET/earthquake-runner/<old-commit>/" \
  --recursive \
  --exclude "*" \
  --include "*.zip" \
  --include "*.tar.gz" \
  --include "*.sha256"

aws s3 rm "s3://$ARTIFACT_BUCKET/membership-identity-runner/<old-commit>/" \
  --recursive \
  --exclude "*" \
  --include "*.zip" \
  --include "*.tar.gz" \
  --include "*.eif" \
  --include "*.sha256"

aws s3 ls "s3://$ARTIFACT_BUCKET/sonari-verifier-runner/$COMMIT_SHA/" --recursive
aws s3 ls "s3://$ARTIFACT_BUCKET/" --recursive --summarize > /tmp/sonari-verifier-runner-s3-after-cleanup.txt
```

cleanup 中に `sonari-verifier-runner/$COMMIT_SHA/` の artifact を削除してはいけません。

## Cost と resource 確認

Deploy 前と cleanup 後に Cost Explorer を確認します。Cost Explorer は遅延するため、直後の確認では live AWS resource inventory を使ってください。

```bash
MONTH_START="$(date -u +%Y-%m-01)"
TODAY="$(date -u +%Y-%m-%d)"

aws ce get-cost-and-usage \
  --time-period "Start=$MONTH_START,End=$TODAY" \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE
```

次の immediate check を deploy 前、artifact upload 後、deploy 後、smoke 後、cleanup 後に実行します。

```bash
aws ec2 describe-instances \
  --filters Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[].{InstanceId:InstanceId,Type:InstanceType,Name:Tags[?Key==`Name`].Value|[0]}'
aws autoscaling describe-auto-scaling-groups \
  --query 'AutoScalingGroups[].{Name:AutoScalingGroupName,Desired:DesiredCapacity,Running:length(Instances[?LifecycleState==`InService`])}'
aws ec2 describe-nat-gateways --query 'NatGateways[].{Id:NatGatewayId,State:State}'
aws ec2 describe-addresses --query 'Addresses[].{AllocationId:AllocationId,AssociationId:AssociationId}'
aws elbv2 describe-load-balancers --query 'LoadBalancers[].{Name:LoadBalancerName,State:State.Code}'
aws scheduler list-schedules --query 'Schedules[].{Name:Name,State:State}'
aws cloudformation describe-stacks --query 'Stacks[].{Name:StackName,Status:StackStatus}'
aws s3 ls "s3://$ARTIFACT_BUCKET/" --recursive --summarize
```

Smoke と cleanup 後の期待 idle state:

- running EC2 が `0`。
- ASG desired/running が `0/0`。
- NAT gateway、Elastic IP、load balancer に説明不能な常時稼働 resource がない。
- EventBridge schedule が `DISABLED` のまま。
- CloudFormation stack が期待する completed state にある。
- S3 inventory に retained artifact と runner result だけが残っている。

## Rollback 手順

Rollback は Git revert と redeploy で行います。問題の commit を revert し、その reverted tree から artifact set を rebuild し、`sonari-verifier-runner/<commit>/` に upload し、deploy plan を再生成して同じ CloudFormation deploy command を実行します。古い runner stack は rollback dependency ではありません。
