# Sonari verifier runner AWS runbook

This stack runs earthquake verification and membership identity verification through one AWS runner capacity pool. Manual operations must use the validated deploy plan script for artifact parameters. Do not assemble artifact keys or checksum parameters by hand.

## Required account

Run every AWS command from account `595103996064`.

```bash
EXPECTED_ACCOUNT_ID=595103996064
ACTUAL_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
test "$ACTUAL_ACCOUNT_ID" = "$EXPECTED_ACCOUNT_ID"
```

## Required artifact set

Each deploy uses the exact Git commit being deployed and uploads all artifacts under `sonari-verifier-runner/<commit>/`.

- `sonari-verifier-runner-lambda.zip`
- `earthquake-tee-artifact.tar.gz`
- `membership-identity-tee-artifact.tar.gz`
- `membership-identity-tee.eif`
- checksum files or captured SHA-256 values for the TEE tarballs and EIF

```bash
COMMIT_SHA="$(git rev-parse HEAD)"
ARTIFACT_BUCKET="${AWS_SONARI_VERIFIER_RUNNER_DEV_ARTIFACT_BUCKET:?}"
STACK_NAME="${AWS_SONARI_VERIFIER_RUNNER_DEV_STACK_NAME:?}"

pnpm install --frozen-lockfile
pnpm check
pnpm test:oracle
pnpm test:identity
pnpm build:aws-sonari-verifier-runner-lambda
pnpm build:aws-earthquake-tee-artifact
pnpm build:aws-membership-identity-tee-artifact
pnpm build:aws-membership-identity-eif

sha256sum -c dist/aws/earthquake-tee-artifact.tar.gz.sha256
sha256sum -c dist/aws/membership-identity-tee-artifact.tar.gz.sha256

aws s3 cp \
  dist/aws/sonari-verifier-runner-lambda.zip \
  "s3://$ARTIFACT_BUCKET/sonari-verifier-runner/$COMMIT_SHA/sonari-verifier-runner-lambda.zip"
aws s3 cp \
  dist/aws/earthquake-tee-artifact.tar.gz \
  "s3://$ARTIFACT_BUCKET/sonari-verifier-runner/$COMMIT_SHA/earthquake-tee-artifact.tar.gz"
aws s3 cp \
  dist/aws/membership-identity-tee-artifact.tar.gz \
  "s3://$ARTIFACT_BUCKET/sonari-verifier-runner/$COMMIT_SHA/membership-identity-tee-artifact.tar.gz"
aws s3 cp \
  dist/aws/membership-identity-tee.eif \
  "s3://$ARTIFACT_BUCKET/sonari-verifier-runner/$COMMIT_SHA/membership-identity-tee.eif"
```

## Manual deploy

Create the deploy plan first. It validates the commit SHA, all SHA-256 values, the `sonari-verifier-runner/<commit>/` prefix, and the mainnet dummy World ID proof gate. The generated `parameterOverrideArgs` are the only artifact parameters to pass into CloudFormation.

```bash
EARTHQUAKE_TEE_SHA256="$(cut -d ' ' -f 1 dist/aws/earthquake-tee-artifact.tar.gz.sha256)"
MEMBERSHIP_TEE_SHA256="$(cut -d ' ' -f 1 dist/aws/membership-identity-tee-artifact.tar.gz.sha256)"
MEMBERSHIP_EIF_SHA256="$(sha256sum dist/aws/membership-identity-tee.eif | cut -d ' ' -f 1)"

pnpm tsx scripts/aws_sonari_verifier_runner_deploy_plan.ts \
  --commit-sha "$COMMIT_SHA" \
  --lambda-bucket "$ARTIFACT_BUCKET" \
  --earthquake-tee-bucket "$ARTIFACT_BUCKET" \
  --earthquake-tee-sha256 "$EARTHQUAKE_TEE_SHA256" \
  --membership-tee-bucket "$ARTIFACT_BUCKET" \
  --membership-tee-sha256 "$MEMBERSHIP_TEE_SHA256" \
  --membership-eif-bucket "$ARTIFACT_BUCKET" \
  --membership-eif-sha256 "$MEMBERSHIP_EIF_SHA256" \
  --relayer-network "${RELAYER_NETWORK:-testnet}" \
  --world-id-proof-mode "${WORLD_ID_PROOF_MODE:-dummy}" \
  --prefix sonari-verifier-runner \
  --out dist/aws/sonari-verifier-runner-deploy-plan.json

mapfile -t deploy_plan_parameter_overrides < <(
  jq -r '.parameterOverrideArgs[]' dist/aws/sonari-verifier-runner-deploy-plan.json
)

printf '%s\n' "${deploy_plan_parameter_overrides[@]}" | grep '^ScheduleState=DISABLED$'

aws cloudformation deploy \
  --template-file infra/aws/sonari-verifier-runner/template.yaml \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides "${deploy_plan_parameter_overrides[@]}" \
  --no-fail-on-empty-changeset
```

For first creation or any update that needs environment-specific stack parameters, use the reviewed account parameter source for this stack and append it to the same command. Keep artifact parameters from the deploy plan. Do not hand-write `LambdaCodeS3Key`, TEE keys, checksum values, `GitCommitSha`, or `ScheduleState`.

`NitroEnclaveImageSha384` is the EIF `PCR0` measurement. `NitroEnclavePcr3` is the SHA-384 digest of 48 NUL bytes followed by the deterministic runner role ARN:

```bash
RUNNER_ROLE_ARN="arn:aws:iam::$EXPECTED_ACCOUNT_ID:role/sonari-verifier-runner-$STACK_NAME-runner"
NITRO_ENCLAVE_PCR3="$(ROLE_ARN="$RUNNER_ROLE_ARN" python3 - <<'PY'
import hashlib
import os

digest = hashlib.sha384()
digest.update(b"\0" * 48)
digest.update(os.environ["ROLE_ARN"].encode("utf-8"))
print(digest.hexdigest())
PY
)"
```

Validate that the mainnet dummy proof guard rejects before deploy:

```bash
if pnpm tsx scripts/aws_sonari_verifier_runner_deploy_plan.ts \
  --commit-sha "$COMMIT_SHA" \
  --lambda-bucket "$ARTIFACT_BUCKET" \
  --earthquake-tee-bucket "$ARTIFACT_BUCKET" \
  --earthquake-tee-sha256 "$EARTHQUAKE_TEE_SHA256" \
  --membership-tee-bucket "$ARTIFACT_BUCKET" \
  --membership-tee-sha256 "$MEMBERSHIP_TEE_SHA256" \
  --membership-eif-bucket "$ARTIFACT_BUCKET" \
  --membership-eif-sha256 "$MEMBERSHIP_EIF_SHA256" \
  --relayer-network mainnet --world-id-proof-mode dummy \
  --out /tmp/sonari-verifier-runner-mainnet-dummy-plan.json; then
  echo "mainnet dummy proof plan unexpectedly succeeded" >&2
  exit 1
fi
```

## Runtime smoke

Read stack outputs once and reuse them for both verifier smoke checks.

```bash
stack_output() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" \
    --output text
}

earthquake_sfn_arn="$(stack_output EarthquakeRunnerStateMachineArn)"
membership_sfn_arn="$(stack_output MembershipRunnerStateMachineArn)"
asg_name="$(stack_output RunnerAutoScalingGroupName)"
watcher_schedule_name="$(stack_output WatcherScheduleName)"
batch_schedule_name="$(stack_output BatchScheduleName)"
manual_watcher_lambda_name="$(stack_output ManualWatcherLambdaName)"
submit_verification_lambda_name="$(stack_output SubmitVerificationLambdaName)"
runner_log_group_name="$(stack_output RunnerLogGroupName)"
```

Earthquake manual workflow:

```bash
manual_watcher_url="$(aws lambda get-function-url-config \
  --function-name "$manual_watcher_lambda_name" \
  --query FunctionUrl \
  --output text)"

curl -fsS -X POST "$manual_watcher_url" \
  -H 'content-type: application/json' \
  --data '{"source_event_id":"<usgs-source-event-id>"}'

aws stepfunctions list-executions \
  --state-machine-arn "$earthquake_sfn_arn" \
  --status-filter SUCCEEDED \
  --max-results 1
```

Membership dummy proof smoke is devnet or testnet only. Use a dummy proof payload with the same request shape as `pnpm identity:smoke`, then invoke the submit Lambda and confirm the membership workflow succeeds.

```bash
test "${RELAYER_NETWORK:-testnet}" != mainnet

aws lambda invoke \
  --function-name "$submit_verification_lambda_name" \
  --payload fileb://dist/aws/membership-dummy-proof-devnet.json \
  /tmp/sonari-membership-dummy-proof-response.json

aws stepfunctions list-executions \
  --state-machine-arn "$membership_sfn_arn" \
  --status-filter SUCCEEDED \
  --max-results 1
```

The required smoke result is:

- earthquake manual workflow reaches Step Functions `SUCCEEDED`
- membership dummy proof smoke succeeds on devnet or testnet only
- mainnet dummy proof is rejected before deploy
- no unresolved CloudWatch log errors remain in RunnerControl, Lambda, or Step Functions logs
- `RunnerAutoScalingGroupName` has `DesiredCapacity=0`
- ASG `InService` instances are `0`
- running EC2 instances: 0
- `WatcherScheduleName` is `DISABLED`
- `BatchScheduleName` is `DISABLED`

```bash
aws logs filter-log-events \
  --log-group-name "$runner_log_group_name" \
  --filter-pattern '?ERROR ?Error ?Exception ?Task timed out'

aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names "$asg_name" \
  --query 'AutoScalingGroups[0].{DesiredCapacity:DesiredCapacity,InService:length(Instances[?LifecycleState==`InService`])}'

aws ec2 describe-instances \
  --filters "Name=tag:aws:autoscaling:groupName,Values=$asg_name" "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].InstanceId' \
  --output text

aws scheduler get-schedule --name "$watcher_schedule_name" --query State --output text
aws scheduler get-schedule --name "$batch_schedule_name" --query State --output text
```

## Old AWS-side file cleanup

Only after the new stack smoke succeeds and the resource inventory confirms idle, remove old AWS-side files. Cleanup scope is old S3 prefixes, old Lambda zip objects, old TEE tarball objects, old EIF objects, and old SHA objects only. Real old AWS stack deletion is a follow-up and out of scope.

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

Do not remove `sonari-verifier-runner/$COMMIT_SHA/` artifacts during cleanup.

## Cost and resource checks

Use Cost Explorer before deploy and after cleanup. Cost Explorer can lag, so immediate checks must use live AWS resource inventory.

```bash
MONTH_START="$(date -u +%Y-%m-01)"
TODAY="$(date -u +%Y-%m-%d)"

aws ce get-cost-and-usage \
  --time-period "Start=$MONTH_START,End=$TODAY" \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE
```

Run these immediate checks before deploy, after artifact upload, after deploy, after smoke, and after cleanup:

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

The expected idle state after smoke and cleanup is:

- running EC2 is `0`
- ASG desired/running is `0/0`
- NAT gateways, Elastic IPs, and load balancers have no unexplained always-on resource
- EventBridge schedules stay `DISABLED`
- CloudFormation stacks are in an expected completed state
- S3 inventory contains only retained artifacts and runner results

## Rollback

Rollback is Git revert plus redeploy. Revert the bad commit, rebuild the artifact set from that reverted tree, upload it under `sonari-verifier-runner/<commit>/`, regenerate the deploy plan, and run the same CloudFormation deploy command. The old runner stacks are not a rollback dependency.
