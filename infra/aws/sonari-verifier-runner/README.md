# Sonari verifier runner AWS 運用手順

この stack は、地震検証と membership identity 検証を 1 つの AWS runner capacity pool で実行します。手動運用では、artifact parameter に必ず検証済み deploy plan script を使ってください。artifact key や checksum parameter を手で組み立ててはいけません。

## 必須 AWS account

すべての AWS command は account `595103996064` から実行します。

```bash
EXPECTED_ACCOUNT_ID=595103996064
ACTUAL_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
test "$ACTUAL_ACCOUNT_ID" = "$EXPECTED_ACCOUNT_ID"
```

## GitHub Actions dev environment

自動 deploy は GitHub environment `aws-sonari-verifier-runner-dev` の Actions variables を使います。この environment に必須値がない場合、workflow は AWS credential 設定前の `Validate dev deployment inputs` で fail-closed します。

既存 stack を正として復旧する場合は、`.github/workflows/aws-sonari-verifier-runner-dev-deploy.yml` の `required_names` と job-level `env` を source of truth にし、`aws cloudformation describe-stacks --stack-name sonari-verifier-runner-dev` の Parameters から stack 固有値を同期します。GitHub variables には AWS 側 resource ARN だけを設定し、credential material は入れません。

source archiver を有効にする dev stack では、次の Actions variables も必須です。値は ARN だけを置き、token、wallet、config の中身は GitHub variables に入れません。

- `AWS_SONARI_VERIFIER_RUNNER_DEV_SOURCE_ARCHIVER_TOKEN_SECRET_ARN`
- `AWS_SONARI_VERIFIER_RUNNER_DEV_SOURCE_ARCHIVER_WALRUS_ENV_SECRET_ARN`
- `AWS_SONARI_VERIFIER_RUNNER_DEV_SOURCE_ARCHIVER_WALRUS_LAYER_ARN`

`SOURCE_ARCHIVER_TOKEN_SECRET_ARN` は RunnerControl と archiver Lambda が共有する呼び出し token です。Function URL はこの token header がない request を拒否します。

`SOURCE_ARCHIVER_WALRUS_ENV_SECRET_ARN` は Walrus CLI 実行に必要な環境変数を JSON object として持ちます。secret は archiver Lambda だけが読みます。

`SOURCE_ARCHIVER_WALRUS_LAYER_ARN` は `/opt/bin/walrus` を提供する Lambda layer です。TEE と runner EC2 には Walrus wallet、config、store 用 secret を置きません。

OIDC role の trust policy は、`repo:UnagiLabs/Sonari:environment:aws-sonari-verifier-runner-dev` だけを許可します。旧 `aws-earthquake-runner-dev` environment は統合 runner への移行後に削除済みの前提です。

devnet / testnet の dummy World ID proof では、任意 variables として World ID proof mode を `dummy`、relayer network を `testnet` に設定します。`NITRO_ENCLAVE_PCR3` は runner role ARN から下記の手順で再計算し、stack parameter と一致させてください。

## 必須 artifact set

各 deploy は、deploy 対象の Git commit をそのまま使い、すべての artifact を `sonari-verifier-runner/<commit>/` 配下へ upload します。

- `sonari-verifier-runner-lambda.zip`
- `earthquake-tee-artifact.tar.gz`
- `earthquake-tee.eif`
- `membership-identity-tee-artifact.tar.gz`
- `membership-identity-tee.eif`
- TEE tarball と EIF の checksum file、または取得済み SHA-256 値

`earthquake-tee-artifact.tar.gz` は `bin/tee`、`bin/walrus`、`bin/vsock-tcp-bridge` を含みます。`bin/walrus` は TEE 内で raw source bytes から deterministic blob id を計算するためだけに使い、TEE は `walrus store` を実行しません。Walrus への実保存、pin、retry、aggregator fetch による再検証は TEE 外の archiver が担います。`SONARI_WALRUS_N_SHARDS=1000` は対象 Walrus network の shard count と一致している必要があります。network、protocol、shard count を変える場合は、VerifierConfig version、PCR、source policy を同時に更新してください。runner EC2 は earthquake 用に allowlist 付き HTTPS CONNECT proxy と vsock proxy を systemd で起動し、enclave 側の local proxy URL は `SONARI_EARTHQUAKE_EGRESS_PROXY_URL=http://127.0.0.1:18080` です。allowlist は USGS に限定します。

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
pnpm build:aws-earthquake-eif
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
  dist/aws/earthquake-tee.eif \
  "s3://$ARTIFACT_BUCKET/sonari-verifier-runner/$COMMIT_SHA/earthquake-tee.eif"
aws s3 cp \
  dist/aws/membership-identity-tee-artifact.tar.gz \
  "s3://$ARTIFACT_BUCKET/sonari-verifier-runner/$COMMIT_SHA/membership-identity-tee-artifact.tar.gz"
aws s3 cp \
  dist/aws/membership-identity-tee.eif \
  "s3://$ARTIFACT_BUCKET/sonari-verifier-runner/$COMMIT_SHA/membership-identity-tee.eif"
```

## 手動 deploy

最初に deploy plan を作成します。deploy plan は commit SHA、すべての SHA-256 値、`sonari-verifier-runner/<commit>/` prefix、mainnet dummy World ID proof gate を検証します。生成された `parameterOverrideArgs` だけを CloudFormation に渡す artifact parameter として使います。

```bash
EARTHQUAKE_TEE_SHA256="$(cut -d ' ' -f 1 dist/aws/earthquake-tee-artifact.tar.gz.sha256)"
EARTHQUAKE_EIF_SHA256="$(sha256sum dist/aws/earthquake-tee.eif | cut -d ' ' -f 1)"
MEMBERSHIP_TEE_SHA256="$(cut -d ' ' -f 1 dist/aws/membership-identity-tee-artifact.tar.gz.sha256)"
MEMBERSHIP_EIF_SHA256="$(sha256sum dist/aws/membership-identity-tee.eif | cut -d ' ' -f 1)"

pnpm tsx scripts/aws_sonari_verifier_runner_deploy_plan.ts \
  --commit-sha "$COMMIT_SHA" \
  --lambda-bucket "$ARTIFACT_BUCKET" \
  --earthquake-tee-bucket "$ARTIFACT_BUCKET" \
  --earthquake-tee-sha256 "$EARTHQUAKE_TEE_SHA256" \
  --earthquake-eif-bucket "$ARTIFACT_BUCKET" \
  --earthquake-eif-sha256 "$EARTHQUAKE_EIF_SHA256" \
  --membership-tee-bucket "$ARTIFACT_BUCKET" \
  --membership-tee-sha256 "$MEMBERSHIP_TEE_SHA256" \
  --membership-eif-bucket "$ARTIFACT_BUCKET" \
  --membership-eif-sha256 "$MEMBERSHIP_EIF_SHA256" \
  --source-archiver-token-secret-arn "$SOURCE_ARCHIVER_TOKEN_SECRET_ARN" \
  --source-archiver-walrus-env-secret-arn "$SOURCE_ARCHIVER_WALRUS_ENV_SECRET_ARN" \
  --source-archiver-walrus-layer-arn "$SOURCE_ARCHIVER_WALRUS_LAYER_ARN" \
  --relayer-network "${RELAYER_NETWORK:-testnet}" \
  --world-id-proof-mode "${WORLD_ID_PROOF_MODE:-dummy}" \
  --prefix sonari-verifier-runner \
  --out dist/aws/sonari-verifier-runner-deploy-plan.json

mapfile -t deploy_plan_parameter_overrides < <(
  jq -r '.parameterOverrideArgs[]' dist/aws/sonari-verifier-runner-deploy-plan.json
)

printf '%s\n' "${deploy_plan_parameter_overrides[@]}" | grep '^ScheduleState=DISABLED$'

# 地震 relayer を有効にする場合だけ、次のように追加します。
# <PACKAGE_ID> は deploy 済み Move package id に置き換えます。
extra_parameter_overrides=()
# extra_parameter_overrides+=("RelayerTarget=<PACKAGE_ID>::accessor::create_disaster_event_from_signed_payload")

aws cloudformation deploy \
  --template-file infra/aws/sonari-verifier-runner/template.yaml \
  --s3-bucket "$ARTIFACT_BUCKET" \
  --s3-prefix "sonari-verifier-runner/$COMMIT_SHA/cloudformation" \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides "${deploy_plan_parameter_overrides[@]}" "${extra_parameter_overrides[@]}" \
  --no-fail-on-empty-changeset
```

初回作成、または environment-specific な stack parameter が必要な更新では、この stack 用に review 済みの account parameter source を使い、同じ command に追加します。artifact parameter は deploy plan の値を維持してください。`LambdaCodeS3Key`、TEE key、checksum 値、`GitCommitSha`、`ScheduleState` を手書きしてはいけません。

GitHub Actions では、同じ値を environment variable の `AWS_SONARI_VERIFIER_RUNNER_DEV_RELAYER_TARGET` に設定します。空の場合、CloudFormation の `RelayerTarget` は空文字のままです。

`NitroEnclaveImageSha384` は EIF の `PCR0` measurement です。`NitroEnclavePcr3` は、48 個の NUL byte に deterministic runner role ARN を続けた値の SHA-384 digest です。

地震 verifier は Nautilus の server pattern に合わせ、EIF 内で起動時に enclave-local な Ed25519 key を生成し、NSM attestation document の `public_key` にその public key を入れます。runner host は `/opt/sonari/bin/run-earthquake-enclave` から VSOCK で `/health_check`、`/get_attestation`、`/process_data` を呼びます。host は Walrus / Sui config を bootstrap するだけで、finalized payload の署名鍵は host に置きません。

Launch template の user data は、AWS Nitro Enclaves allocator の `/etc/nitro_enclaves/allocator.yaml` を `NitroEnclaveCpuCount` / `NitroEnclaveMemoryMiB` に合わせて更新し、`nitro-enclaves-allocator.service` を restart します。`nitro-cli run-enclave --memory` より小さい hugepage 予約で instance を起動してはいけません。

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

mainnet dummy proof guard が deploy 前に拒否することを確認します。

```bash
if pnpm tsx scripts/aws_sonari_verifier_runner_deploy_plan.ts \
  --commit-sha "$COMMIT_SHA" \
  --lambda-bucket "$ARTIFACT_BUCKET" \
  --earthquake-tee-bucket "$ARTIFACT_BUCKET" \
  --earthquake-tee-sha256 "$EARTHQUAKE_TEE_SHA256" \
  --earthquake-eif-bucket "$ARTIFACT_BUCKET" \
  --earthquake-eif-sha256 "$EARTHQUAKE_EIF_SHA256" \
  --membership-tee-bucket "$ARTIFACT_BUCKET" \
  --membership-tee-sha256 "$MEMBERSHIP_TEE_SHA256" \
  --membership-eif-bucket "$ARTIFACT_BUCKET" \
  --membership-eif-sha256 "$MEMBERSHIP_EIF_SHA256" \
  --source-archiver-token-secret-arn "$SOURCE_ARCHIVER_TOKEN_SECRET_ARN" \
  --source-archiver-walrus-env-secret-arn "$SOURCE_ARCHIVER_WALRUS_ENV_SECRET_ARN" \
  --source-archiver-walrus-layer-arn "$SOURCE_ARCHIVER_WALRUS_LAYER_ARN" \
  --relayer-network mainnet --world-id-proof-mode dummy \
  --out /tmp/sonari-verifier-runner-mainnet-dummy-plan.json; then
  echo "mainnet dummy proof plan unexpectedly succeeded" >&2
  exit 1
fi
```

## 実行時 smoke

Stack output は一度だけ読み、地震と membership の両方の smoke check で再利用します。

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
source_archiver_lambda_name="$(stack_output SourceArchiverLambdaName)"
source_archiver_url="$(stack_output SourceArchiverFunctionUrlOutput)"
```

地震 manual workflow:

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

`pnpm aws:smoke:earthquake-manual` は DynamoDB row から `source_archive_summary` を出力します。`source_archive_status` が `success` であること、`relayer_mode` が `dry_run` であること、`relayer_digest` と `disaster_event_object_id` が `null` であることを確認します。

archiver Lambda の CloudWatch logs では、source artifact ごとに Walrus store が成功していることを確認します。request/response summary には blob id だけを残し、token、wallet、config、private key は出しません。

Membership dummy proof smoke は devnet または testnet 専用です。`pnpm identity:smoke` と同じ request shape の dummy proof payload を使い、submit Lambda を invoke して membership workflow が成功することを確認します。

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

必須の smoke result:

- earthquake manual workflow が Step Functions `SUCCEEDED` に到達する。
- membership dummy proof smoke が devnet または testnet でのみ成功する。
- mainnet dummy proof が deploy 前に拒否される。
- RunnerControl、Lambda、Step Functions log に未解決の CloudWatch log error が残っていない。
- `RunnerAutoScalingGroupName` の `DesiredCapacity=0`。
- ASG の `InService` instance が `0`。
- running EC2 instances が `0`。
- `WatcherScheduleName` が `DISABLED`。
- `BatchScheduleName` が `DISABLED`。

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
