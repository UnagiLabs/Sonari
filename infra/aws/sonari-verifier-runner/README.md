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

source archiver を有効にする dev stack では、次の Actions variables を使います。値は ARN だけを置き、token や private key の中身は GitHub variables に入れません。

- `AWS_SONARI_VERIFIER_RUNNER_DEV_SOURCE_ARCHIVER_TOKEN_SECRET_ARN`
- `AWS_SONARI_VERIFIER_RUNNER_DEV_SOURCE_ARCHIVER_PRIVATE_KEY_SECRET_ARN`

既存 stack の復旧では、`AWS_SONARI_VERIFIER_RUNNER_DEV_SOURCE_ARCHIVER_PRIVATE_KEY_SECRET_ARN` が未設定でも、workflow が AWS account 検証後に CloudFormation parameter `SourceArchiverPrivateKeySecretArn` から ARN を復旧します。GitHub variable と stack parameter のどちらにも値がない場合は fail-closed します。新規 stack 作成時は復旧元の parameter がないため、GitHub variable を設定してください。

`SOURCE_ARCHIVER_TOKEN_SECRET_ARN` は RunnerControl と archiver Lambda が共有する呼び出し token です。Function URL はこの token header がない request を拒否します。

`SOURCE_ARCHIVER_PRIVATE_KEY_SECRET_ARN` は SourceArchiver 専用 hot wallet の raw ED25519 `suiprivkey...` だけを含む secret を指します。JSON、YAML、Sui wallet config、keystore JSON は受け付けません。SourceArchiver は `@mysten/walrus` SDK で `WALRUS_UPLOAD_RELAY_URL` に upload relay 書き込みを行い、既定値は `SUI_NETWORK=testnet`、`SUI_RPC_URL=https://fullnode.testnet.sui.io:443`、`WALRUS_UPLOAD_RELAY_URL=https://upload-relay.testnet.walrus.space`、`WALRUS_UPLOAD_RELAY_TIP_MAX_MIST=1000`、`WALRUS_EPOCHS=1`、`WALRUS_DELETABLE=false` です。secret 本文と private key はログへ出しません。

SourceArchiver Lambda は Walrus CLI layer を使いません。TEE 内の deterministic blob-id 計算用 Walrus CLI は維持しますが、Lambda upload path は SDK のみです。TEE と runner EC2 には Walrus wallet、config、store 用 secret を置きません。

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
  --source-archiver-private-key-secret-arn "$SOURCE_ARCHIVER_PRIVATE_KEY_SECRET_ARN" \
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

## Earthquake PCR config の admin 入口

Earthquake verifier の PCR config は、既存の `admin.move` 関数で管理します。既存の `admin.move` 関数で足りるため、新しい wrapper は追加しません。

| 操作 | 関数 | 権限 |
| --- | --- | --- |
| 初回登録 | `admin::create_earthquake_verifier_config` | `&AdminCap` |
| PCR 更新 | `admin::update_earthquake_verifier_config_pcrs` | `&AdminCap` |
| 緊急停止 | `admin::disable_earthquake_verifier_config` | `&AdminCap` |

これらの関数は外部 transaction から呼べる `public fun` です。ただし、成功には `&AdminCap` が必要です。AdminCap を持たない wallet は、呼び出しを試せても config を変更できません。

`metadata_verifier` 側の PCR config 関数は package 内部用です。外部運用では `admin` module だけを入口にします。

AWS Runner は `metadata_verifier::register_enclave_instance` を呼びます。Relayer は `accessor::create_disaster_event_from_signed_payload` を呼びます。どちらも AdminCap を持たず、登録済み PCR と attestation、または登録済み enclave instance の署名で検証されます。

### Earthquake EIF から PCR を取得する

Earthquake EIF を作るときは、先に `pnpm build:aws-earthquake-eif` を実行します。この script は内部で `nitro-cli build-enclave` を呼び、build output に PCR0 / PCR1 / PCR2 を出します。

PCR0 / PCR1 / PCR2 は 48 byte SHA-384 measurement です。Move の `vector<u8>` へ渡すときは、`0x` なしの hex を 2 桁ずつ byte に分けます。

例:

```text
PCR0 hex: 0102...3030
Move byte vector: vector[0x01, 0x02, ..., 0x30, 0x30]
```

EarthquakeTeeEifSha256 は EIF file の SHA-256 checksum です。S3 から EC2 が取得した EIF file の改ざん検知に使います。PCR0/1/2 は attestation document の measurement です。Move の `VerifierConfig` は PCR0/1/2 を見て、起動中の enclave が登録済み code/config かを確認します。

### AdminCap transaction と鍵分離

AdminCap を持つ管理者 wallet は AWS に置きません。PCR config の登録、更新、停止は、デプロイ時に Codex が動く管理端末の project-local admin wallet から実行します。AdminCap の秘密鍵や wallet config は AWS Runner、EC2、Lambda、SSM、AWS Secrets Manager に入れてはいけません。

Relayer wallet は AdminCap を持ちません。Relayer wallet は `accessor::create_disaster_event_from_signed_payload` の submit だけに使います。SourceArchiver 用 hot wallet をローカルで扱う場合も admin wallet とは分離し、AWS Secrets Manager の `sonari/walrus-archiver/private-key` は raw `suiprivkey...` secret だけを保持します。

次の値を確認してから admin transaction を実行します。

```bash
PACKAGE_ID="<published-package-id>"
ADMIN_ADDRESS="<admin-wallet-address>"
ADMIN_CAP_ID="<admin-cap-object-id>"
VERIFIER_REGISTRY_ID="<verifier-registry-object-id>"
PCR0_VECTOR='[1,2,3]'
PCR1_VECTOR='[4,5,6]'
PCR2_VECTOR='[7,8,9]'
```

`PCR*_VECTOR` は、48 byte PCR hex を decimal byte 配列へ変換した値です。`0102` は `[1,2]` です。

初回登録:

```bash
sui client call \
  --sender "$ADMIN_ADDRESS" \
  --package "$PACKAGE_ID" \
  --module admin \
  --function create_earthquake_verifier_config \
  --args "$ADMIN_CAP_ID" "$VERIFIER_REGISTRY_ID" "$PCR0_VECTOR" "$PCR1_VECTOR" "$PCR2_VECTOR" \
  --gas-budget 100000000
```

検証コードや measurement 対象 config を変えた後の PCR 更新:

```bash
sui client call \
  --sender "$ADMIN_ADDRESS" \
  --package "$PACKAGE_ID" \
  --module admin \
  --function update_earthquake_verifier_config_pcrs \
  --args "$ADMIN_CAP_ID" "$VERIFIER_REGISTRY_ID" "$PCR0_VECTOR" "$PCR1_VECTOR" "$PCR2_VECTOR" \
  --gas-budget 100000000
```

問題発生時の緊急停止:

```bash
sui client call \
  --sender "$ADMIN_ADDRESS" \
  --package "$PACKAGE_ID" \
  --module admin \
  --function disable_earthquake_verifier_config \
  --args "$ADMIN_CAP_ID" "$VERIFIER_REGISTRY_ID" \
  --gas-budget 100000000
```

登録または更新後は transaction digest の event を確認します。`VerifierConfigCreated` と `VerifierConfigPcrsUpdated` では、actor が `ADMIN_ADDRESS` であること、PCR と config version が想定通りであることを確認します。

緊急停止後は `VerifierConfigDisabled` を確認します。この event は PCR0/1/2 を持たないため、actor が `ADMIN_ADDRESS` であること、config version が停止対象と一致することを確認します。

この手順の PR 前検証では `pnpm check:move` と README test を実行します。本番 AWS 実行はこの手順の必須検証ではありません。実 stack で attestation flow を確認する場合は、別 issue で ASG cleanup と schedule disabled を gate にします。

## Membership identity PCR config の admin 入口

Membership identity verifier の PCR config は、`admin.move` 内の次の関数で管理します。earthquake と同じく、既存の `admin.move` 関数で足りるため、新しい wrapper は追加しません。

| 操作 | 関数 | 権限 |
| --- | --- | --- |
| 初回登録（real submit） | `admin::create_identity_verifier_config` | `&AdminCap` |
| PCR 更新（real submit） | `admin::update_identity_verifier_config_pcrs` | `&AdminCap` |
| 緊急停止 | `admin::disable_identity_verifier_config` | `&AdminCap` |

これらの関数は外部 transaction から呼べる `public fun` です。ただし、成功には `&AdminCap` が必要です。AdminCap を持たない wallet は、呼び出しを試せても config を変更できません。

**register（real submit）と update（dry-run）の semantics（#129 案A）:** `create_identity_verifier_config` は VerifierRegistry に membership identity config を新規作成する real submit です。`update_identity_verifier_config_pcrs` は登録済み config の PCR を更新する real submit です。全部 dry-run は登録済み enclave state を要するため不可です。初回は必ず `create_identity_verifier_config` で実 submit してください。更新時の `update_identity_verifier_config_pcrs` も実 submit です。smoke test の dummy proof は実際の config 登録とは無関係で、devnet/testnet 専用の動作確認に使います。

### Membership identity EIF から PCR を取得する

Membership identity EIF を作るときは、先に `pnpm build:aws-membership-identity-eif` を実行します。この script は内部で `nitro-cli build-enclave` を呼び、build output に PCR0 / PCR1 / PCR2 を出します。

GitHub Actions deploy workflow を使った場合は、run summary の `### Membership Identity EIF PCRs` セクションに PCR の値が表示されます。手元で EIF を build した場合は、次のコマンドで PCR を取得できます。

```bash
nitro-cli describe-eif \
  --eif-path dist/aws/membership-identity-tee.eif
```

PCR0 / PCR1 / PCR2 は 48 byte SHA-384 measurement です。Move の `vector<u8>` へ渡すときは、`0x` なしの hex を 2 桁ずつ byte に分けます。

例:

```text
PCR0 hex: 0102...3030
Move byte vector: vector[0x01, 0x02, ..., 0x30, 0x30]
```

MembershipIdentityTeeEifSha256 は EIF file の SHA-256 checksum です。S3 から EC2 が取得した EIF file の改ざん検知に使います。PCR0/1/2 は attestation document の measurement です。Move の `VerifierConfig` は PCR0/1/2 を見て、起動中の enclave が登録済み code/config かを確認します。

### Membership identity AdminCap transaction

AdminCap を持つ管理者 wallet は AWS に置きません。PCR config の登録、更新、停止は、デプロイ時に Codex が動く管理端末の project-local admin wallet から実行します。AdminCap の秘密鍵や wallet config は AWS Runner、EC2、Lambda、SSM、AWS Secrets Manager に入れてはいけません。

次の値を確認してから admin transaction を実行します（earthquake と同じ変数セットを使います）。

```bash
PACKAGE_ID="<published-package-id>"
ADMIN_ADDRESS="<admin-wallet-address>"
ADMIN_CAP_ID="<admin-cap-object-id>"
VERIFIER_REGISTRY_ID="<verifier-registry-object-id>"
PCR0_VECTOR='[1,2,3]'
PCR1_VECTOR='[4,5,6]'
PCR2_VECTOR='[7,8,9]'
```

`PCR*_VECTOR` は、48 byte PCR hex を decimal byte 配列へ変換した値です。EIF build 後に GitHub Actions run summary または `nitro-cli describe-eif` で取得した値を使います。

初回登録（real submit）:

```bash
sui client call \
  --sender "$ADMIN_ADDRESS" \
  --package "$PACKAGE_ID" \
  --module admin \
  --function create_identity_verifier_config \
  --args "$ADMIN_CAP_ID" "$VERIFIER_REGISTRY_ID" "$PCR0_VECTOR" "$PCR1_VECTOR" "$PCR2_VECTOR" \
  --gas-budget 100000000
```

検証コードや measurement 対象 config を変えた後の PCR 更新（real submit）:

```bash
sui client call \
  --sender "$ADMIN_ADDRESS" \
  --package "$PACKAGE_ID" \
  --module admin \
  --function update_identity_verifier_config_pcrs \
  --args "$ADMIN_CAP_ID" "$VERIFIER_REGISTRY_ID" "$PCR0_VECTOR" "$PCR1_VECTOR" "$PCR2_VECTOR" \
  --gas-budget 100000000
```

問題発生時の緊急停止:

```bash
sui client call \
  --sender "$ADMIN_ADDRESS" \
  --package "$PACKAGE_ID" \
  --module admin \
  --function disable_identity_verifier_config \
  --args "$ADMIN_CAP_ID" "$VERIFIER_REGISTRY_ID" \
  --gas-budget 100000000
```

登録または更新後は transaction digest の event を確認します。`VerifierConfigCreated` と `VerifierConfigPcrsUpdated` では、actor が `ADMIN_ADDRESS` であること、PCR と config version が想定通りであることを確認します。

緊急停止後は `VerifierConfigDisabled` を確認します。この event は PCR0/1/2 を持たないため、actor が `ADMIN_ADDRESS` であること、config version が停止対象と一致することを確認します。

この手順の PR 前検証では `pnpm check:move` と README test を実行します。本番 AWS 実行はこの手順の必須検証ではありません。実 stack で attestation flow を確認する場合は、別 issue で ASG cleanup と schedule disabled を gate にします。

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
  --source-archiver-private-key-secret-arn "$SOURCE_ARCHIVER_PRIVATE_KEY_SECRET_ARN" \
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

## 3 例目の verifier_kind を追加するときの手順

新しい verifier_kind（例: `new_verifier`）を追加するには、以下の単位を丸ごと複製して調整してください。

### 1. CloudFormation Parameters の複製

下記の Parameter ペアを `template.yaml` の `Parameters:` ブロックに追加します。

- TEE artifact: `TeeArtifactS3Bucket`・`TeeArtifactS3Key`・`TeeArtifactSha256` の形式で新種名を prefix に付けた 3 パラメータ（例: `NewVerifierTeeArtifactS3Bucket` など）
- EIF: `TeeEifS3Bucket`・`TeeEifS3Key`・`TeeEifSha256` の形式で 3 パラメータ
- NitroEnclaveProcessCommand: 新 wrapper のデフォルトパスを持つ 1 パラメータ
- ScheduleExpression: 独自スケジュールが必要な場合のみ 1 パラメータ

### 2. dispatcher (`run-sonari-verifier`) の拡張

EC2 user-data 内の `run-sonari-verifier` スクリプト（`SONARI_VERIFIER_KIND` で分岐する `case` 文）に新しい kind の `case` を追加します。

```bash
case "${SONARI_VERIFIER_KIND:-earthquake}" in
  "membership_identity")
    exec "${!SONARI_MEMBERSHIP_NITRO_ENCLAVE_PROCESS_COMMAND:-/opt/sonari/bin/run-membership-identity-enclave}"
    ;;
  "new_verifier")
    exec "${!SONARI_NEW_VERIFIER_NITRO_ENCLAVE_PROCESS_COMMAND:-/opt/sonari/bin/run-new-verifier-enclave}"
    ;;
  *)
    exec "${!SONARI_EARTHQUAKE_NITRO_ENCLAVE_PROCESS_COMMAND:-/opt/sonari/bin/run-earthquake-enclave}"
    ;;
esac
```

### 3. enclave wrapper スクリプトの追加

user-data に `run-new-verifier-enclave` の wrapper スクリプトを追加します。`run-membership-identity-enclave` を template として複製し、EIF path 変数名を新 kind に合わせて変更してください。

### 4. runner.env の env namespace

`runner.env` 書き込みブロックに新 kind のエントリを追加します。

- `SONARI_<KIND>_ENCLAVE_CID=${NitroEnclaveCid}` — 共有 NitroEnclaveCid から出力
- `SONARI_<KIND>_EIF_PATH` — 新 EIF のダウンロードパス
- `SONARI_<KIND>_NITRO_RUN_ENCLAVE_ARGS` — `nitro-cli run-enclave` 引数

### 5. RunnerControlLambda の env namespace

`RunnerControlLambda` の `Environment.Variables` に新 kind 専用の Parameters を参照する env var を追加します。earthquake の `RELAYER_*` namespace と membership の `IDENTITY_RELAYER_*` / `SONARI_IDENTITY_*` namespace は変更しないでください。新 kind には独立した namespace を付与します。

### 6. StateMachine の複製

`EarthquakeRunnerStateMachine` または `MembershipRunnerStateMachine` を template として複製し、新しい `NewVerifierRunnerStateMachine` リソースを追加します。`verifier_kind` の初期 Input を `"new_verifier"` に変更します。

### 7. BatchSchedule の追加

`BatchSchedule` に相当する新しい EventBridge スケジュールリソースを追加し、`MembershipScheduleExpression` と同様に `ScheduleExpression` パラメータを作成します。スケジュールの `State` は共有の `ScheduleState` パラメータ（既定 `DISABLED`）を参照します。

### 8. runner src の `SONARI_VERIFIER_KIND` export

`buildSsmShellCommand`（runner src）の新 kind 向け呼び出し箇所で `SONARI_VERIFIER_KIND=new_verifier` を `export` するよう追加します。earthquake は `runner_workflow.ts` の SSM dispatch で直接 set するのではなく enclave wrapper が使う既定値で処理し、membership は `buildSsmShellCommand` で `export SONARI_VERIFIER_KIND=membership_identity` を先頭に追加します。

### 9. deploy workflow の追加ステップ

`.github/workflows/aws-sonari-verifier-runner-dev-deploy.yml` に次を追加します。

- `pnpm build:aws-new-verifier-tee-artifact` — TEE artifact ビルド
- `pnpm build:aws-new-verifier-eif` — EIF ビルドと PCR サマリ出力
- S3 upload ステップ（`sonari-verifier-runner/$COMMIT_SHA/new-verifier-tee-artifact.tar.gz` と `new-verifier-tee.eif`）
- `deploy_plan.ts` への `--new-verifier-tee-sha256` と `--new-verifier-eif-sha256` 引数
- CloudFormation の parameter override 追加

## Earthquake 経路の非回帰制約

earthquake の runner / relayer / deploy / egress 経路は、新しい verifier_kind を追加しても変更しないでください。

- **RELAYER_MODE / RELAYER_NETWORK** など `RELAYER_*` namespace の env var は earthquake 専用です。新 kind の relayer には独自 namespace を使い、`RELAYER_*` を流用または改名しないでください。
- **rate(5 minutes)** — earthquake の `ScheduleExpression` デフォルトは `rate(5 minutes)` を保持してください。membership の `MembershipScheduleExpression` デフォルト `rate(1 day)` も変更しないでください。
- **egress proxy** — earthquake の CONNECT proxy（port 18081）と vsock-proxy（18080 → 127.0.0.1:18081）は `earthquake.usgs.gov:443` allowlist とともに変更しないでください。
- **enclave CID** — `SONARI_EARTHQUAKE_ENCLAVE_CID` は `${NitroEnclaveCid}` から出力する 1 行を保持してください。
