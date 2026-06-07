# Smoke runbook

この runbook は deploy 後の runtime smoke、一気通貫 smoke、失敗時の切り分け、証跡保存を扱います。AWS 関連 smoke では ad hoc AWS CLI command より `scripts/aws/README.md` の script を優先してください。

## Stack output

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

## Earthquake manual workflow

手動で Lambda URL を叩く場合:

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

dry-run 設定の smoke では、`pnpm aws:smoke:earthquake-manual` が DynamoDB row から `source_archive_summary` を出力します。`source_archive_status` が `success` であること、`relayer_mode` が `dry_run` であること、`relayer_digest` と `disaster_event_object_id` が `null` であることを確認します。

archiver Lambda の CloudWatch logs では、source artifact ごとに Walrus store が成功していることを確認します。request/response summary には blob id だけを残し、token、wallet、config、private key は出しません。

## Earthquake manual smoke の実行ノウハウ

ManualWatcher の smoke は、`pnpm aws:smoke:earthquake-manual` の終了だけでは完了判定しません。この script は ManualWatcher Lambda URL に event を投入し、直近の Step Functions と DynamoDB row を読むだけなので、workflow が `RUNNING` の時点では `source_archive_summary` が `null` のまま出ることがあります。

一気通貫で確認するときは、先に deploy commit と stack の `DeployedGitCommitSha` が一致することを確認し、`pnpm aws:post-deploy-guardrails` と `pnpm aws:check-idle` を通します。submit まで見る場合は、stack config の `RelayerMode=submit`、`RelayerAllowSubmit=true`、`RelayerTarget`、`RelayerVerifierRegistry`、relayer signer secret が正しいこと、GitHub Actions summary の earthquake EIF PCR0/1/2 と Sui `VerifierRegistry` の earthquake config が一致することも確認します。

推奨順序:

1. GitHub Actions deploy workflow を対象 commit で実行する。
2. `pnpm aws:post-deploy-guardrails -- --stack sonari-verifier-runner-dev --region ap-northeast-1 --commit <commit>` を実行する。
3. `pnpm aws:check-idle -- --stack sonari-verifier-runner-dev --region ap-northeast-1` を実行する。
4. `pnpm aws:verify:source-archiver -- --stack sonari-verifier-runner-dev --region ap-northeast-1` を実行する。
5. `pnpm aws:verify:earthquake-wrapper -- --stack sonari-verifier-runner-dev --region ap-northeast-1 --commit <commit> --source-event-id <source_event_id>` を実行する。
6. `pnpm aws:smoke:earthquake-manual -- --stack sonari-verifier-runner-dev --region ap-northeast-1 --source-event-id <source_event_id>` を実行する。
7. 対象 Step Functions execution と DynamoDB row を terminal status まで追跡する。
8. SourceArchiver logs と secret 非露出を確認する。
9. DynamoDB row と row に記録された S3 object、`source-artifacts/<source_event_id>/` prefix を cleanup する。
10. 最後に `pnpm aws:check-idle` を再実行する。

成功判定は、対象 execution が terminal status になった後の DynamoDB row で行います。

- Step Functions execution が `SUCCEEDED`
- DynamoDB row の `source_archive_status` が `success`
- `relayer_mode` が `submit`
- `relayer_status` が `succeeded`
- `relayer_digest` が non-null
- `disaster_event_object_id` または `relayer_object_id` が non-null
- SourceArchiver logs に Walrus store success と `registered` / `uploaded` / `certified` がある
- logs に token、private key、secret が出ていない
- 最後に `pnpm aws:check-idle` が通る

証跡は `.local/sonari-dev/aws-test-results/<run-id>/` に保存します。DynamoDB row before/after、Step Functions execution ARN/status/history、runner result S3 key、relayer digest/object id、Walrus blob ids、SourceArchiver log summary を残します。secret、token、private key は保存しません。

## よくある詰まり

`Execution Already Exists` が出る場合、対象 event の過去 Step Functions execution name と衝突しています。DynamoDB row を削除すると `retry_count` が `0` に戻り、`earthquake-<source_event_id>-1` から再利用しようとします。過去 execution の最大 suffix を確認し、再実行ではそれより大きい attempt になるように row の `retry_count` を調整するか、新しい `source_event_id` を使います。

`AWS_RUNNER_PROCESS_FAILED` と `metadata_verifier::assert_attestation_pcr_matches` abort code 21 が出る場合、deployed EIF の PCR0/1/2 と Sui `VerifierRegistry` の earthquake config が一致していません。GitHub Actions deploy run の `Earthquake EIF PCRs` から PCR0/1/2 を取得し、AdminCap wallet で `admin::update_earthquake_verifier_config_pcrs` を実行します。更新後は config version と transaction digest を記録してから再実行します。

`scripts/register-verifier-configs.sh` は、既存 config abort 表現の `with code 9` も already registered として扱い、create 失敗後に PCR update へ進みます。

SourceArchiver 単体は `pnpm aws:verify:source-archiver` で先に確認します。ここで Walrus blob id が expected と一致し、success log が出ていれば、ManualWatcher smoke の失敗原因を runner / PCR / relayer 側へ切り分けやすくなります。

## Membership dummy proof smoke

Membership dummy proof smoke は devnet または testnet 専用です。`pnpm identity:smoke` と同じ request shape の dummy proof payload を使い、submit Lambda を invoke して membership workflow が成功することを確認します。

いまの推奨入口は `pnpm aws:smoke:membership-manual` です。script は fixture の `dummy-world-id-request.json` を読み、`world_id.nullifier_hash` を毎回ユニーク化して `SubmitVerificationLambda` へ送ります。返却 `job_id` を基準に `BatchVerifierLambda` を起動し、DynamoDB job の `workflow_execution_name` と一致する execution だけを追います。

実行前の fail-closed 条件:

- `RelayerNetwork` が `testnet` または `devnet`
- `WorldIdProofMode=dummy`
- `IdentityRelayerMode=submit`
- `RelayerAllowSubmit=true`
- `WatcherScheduleName` と `BatchScheduleName` が `DISABLED`

先に Sui testnet 上の fixture を用意します。
この fixture は未認証の `MembershipPass` から始まります。

fixture が出す `world_app_id` は、対象スタックの `WORLD_ID_APP_ID` と一致させます。enclave は本人確認の前に、リクエストの `world_app_id` が自分の設定値と一致するか確認するからです。値がずれると `WORLD_ID_VERIFICATION_FAILED` で必ず落ちます。

`WORLD_ID_APP_ID` は CloudFormation の `WorldIdAppId` Parameter です。`describe-stacks` の `Stacks[0].Parameters` から読み、`SONARI_WORLD_ID_APP_ID` として export してから fixture を実行します。fixture は `--world-app-id`、env `SONARI_WORLD_ID_APP_ID`、既定値の順で `world_app_id` を解決します。

```bash
SUI_CLIENT_CONFIG="${SUI_CLIENT_CONFIG:?set admin Sui config path}"

# stack_output と同じ要領で Parameter を読むヘルパー。
stack_parameter() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Parameters[?ParameterKey=='$1'].ParameterValue | [0]" \
    --output text
}

export SONARI_WORLD_ID_APP_ID="$(stack_parameter WorldIdAppId)"

pnpm identity:testnet-fixture \
  --sui-config "$SUI_CLIENT_CONFIG" \
  --sui-env testnet \
  --world-app-id "$SONARI_WORLD_ID_APP_ID"

set -a
. .local/sonari-dev/membership-identity-fixture/fixture.env
set +a
```

`fixture.env` は runner と `identity:move-handoff` が読む object id を持ちます。
`dummy-world-id-request.json` は submit Lambda へ渡す request です。
`SONARI_ALLOWED_RESIDENCE_CELL_REGISTRY_ID` は manifest-only です。
AWS runner parameter へ写す値は次の通りです。

```text
SonariIdentityRegistryId=$SONARI_IDENTITY_REGISTRY_ID
SonariMembershipRegistryId=$SONARI_MEMBERSHIP_REGISTRY_ID
SonariVerifierRegistryId=$SONARI_VERIFIER_REGISTRY_ID
```

```bash
test "${RELAYER_NETWORK:-testnet}" != mainnet

jq -c '{body: (. | tostring)}' \
  .local/sonari-dev/membership-identity-fixture/dummy-world-id-request.json \
  > /tmp/sonari-membership-dummy-proof-event.json

aws lambda invoke \
  --function-name "$submit_verification_lambda_name" \
  --payload fileb:///tmp/sonari-membership-dummy-proof-event.json \
  /tmp/sonari-membership-dummy-proof-response.json

aws stepfunctions list-executions \
  --state-machine-arn "$membership_sfn_arn" \
  --status-filter SUCCEEDED \
  --max-results 1
```

推奨コマンド:

```bash
pnpm aws:smoke:membership-manual \
  -- --stack sonari-verifier-runner-dev --region ap-northeast-1
```

成功判定:

- 対象 job の `workflow_execution_name` に一致する execution が `SUCCEEDED`
- DynamoDB job が `completed`
- job `tx_digest` が non-null
- readback の `identityVerified` が `true`
- 最後に `RunnerAutoScalingGroupName` の `DesiredCapacity=0`
- pending/running EC2 が `0`
- `WatcherScheduleName` と `BatchScheduleName` が `DISABLED`

### 再実行ノウハウ（issue #203）

- **毎回 fresh な未認証 MembershipPass が必要**。成功 smoke は owner の本人確認を確定させるため、同じ owner / 同じ provider（World ID）で再 submit すると `identity_registry::record_identity_verification` が `EIdentityProviderReplay`（abort 6）で落ちる。再実行時は新しい鍵で member を登録し直す。
  - 新 owner 鍵を作成し gas を送金 → `active-address` を新 owner に切替 → `pnpm identity:testnet-fixture`（現スタックの `SONARI_IDENTITY_PACKAGE_ID` 等を env で渡す。`SONARI_ALLOWED_RESIDENCE_CELL_REGISTRY_ID` は既存値を渡し AdminCap の二重作成 `EAllowedResidenceCellRegistryAlreadyCreated`(abort 2) を避ける）で fresh pass を mint。
  - register 直後の object 読み戻しは fullnode のレプリカ遅延で `not found` になることがある。その場合は mint 済み pass id を `SONARI_MEMBERSHIP_PASS_ID` に渡して reuse モードで fixture を書き直す。
  - fixture の `world_id.world_app_id` は対象スタックの `WorldIdAppId` Parameter と一致させる（不一致は `WORLD_ID_VERIFICATION_FAILED`）。
- **PCR drift（identity config key=2）**。EIF は再ビルドのたびに measurement がドリフトする。runner registration が `metadata_verifier::assert_attestation_pcr_matches`（abort 21 = `EEnclavePcrMismatch`）で落ちたら、現 EIF を `nitro-cli describe-eif` で計測し `admin::update_identity_verifier_config_pcrs`（または `scripts/register-verifier-configs.sh`）で `VerifierRegistry` の identity config を再登録する。
- smoke スクリプトは cold boot を許容する（terminal 待ちと idle 復帰待ちを polling する）。ASG の termination lag で即時 idle 判定に失敗しない。

## enclave が解決した verifier mode を確認する（issue #190 観測手順）

membership enclave が起動時に受信した `proof_mode`/`network` と、実際に選んだ verifier mode を smoke の後に確認できます。get_attestation 応答に `world_id_mode_observation` フィールドが載るようになりました。

手順:

1. このフィールドを含む観測ビルドを dev stack へ再デプロイします。EIF measurement は再ビルドのたびにドリフトするので、再デプロイ後に `scripts/register-verifier-configs.sh` で identity config の PCR を再登録します。あわせて deploy plan に渡した `membership-identity-tee.eif` の SHA-256 と、実機 instance が起動した EIF measurement が一致することを確認します（EIF ドリフトを論理バグと取り違えないため）。
2. 上の Membership dummy proof smoke を実行します。
3. runner が get_attestation の結果を書く S3 result object を読みます。runner は get_attestation command の結果を result bucket の result key へ保存し、`readEnclaveAttestation` で読み戻します。`readEnclaveAttestation` は未知フィールドを無視しますが、S3 の生 JSON には `world_id_mode_observation` が残ります。

```bash
# 該当 job の get_attestation command が書いた result object を読む
aws s3 cp "s3://$result_bucket/$get_attestation_result_s3_key" - | jq .world_id_mode_observation
```

読み取れる値:

- `resolved_mode`: enclave が選んだ mode（`"real"` または `"dummy"`）。
- `received_proof_mode` / `received_network`: testnet/devnet では bootstrap で受信した生値。dev 以外（mainnet など）では `null`（`redacted: true`）。

判断:

- `resolved_mode` が `"dummy"` なら dummy verifier が使われています（期待どおり）。
- `resolved_mode` が `"real"` なのに host が `proof_mode=dummy` / `network=testnet` を送っているなら、issue #190 の runtime 乖離です。`received_proof_mode` / `received_network` の生値で、enclave に dummy が届いていたか（空文字や欠落でないか）を切り分けられます。

注意:

- この観測値は診断専用です。署名済みの NSM attestation document の外側にある平文で、host が bootstrap で渡した入力の写しに過ぎません。信頼の根拠（trust anchor）には使いません。
- mainnet では生値を伏せます（`redacted: true`）。fail-closed の安全装置（mainnet で dummy 不可）は `resolve_world_id_verifier_mode` が担保します。

## 必須の smoke result

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
