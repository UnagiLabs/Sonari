# Deploy runbook

この runbook は `infra/aws/sonari-verifier-runner` stack の GitHub Actions dev environment、artifact set、manual deploy を扱います。

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

devnet / testnet の dummy World ID proof では、任意 variables として World ID proof mode を `dummy`、relayer network を `testnet` に設定します。`NITRO_ENCLAVE_PCR3` は runner role ARN から `docs/pcr-config.md` の手順で再計算し、stack parameter と一致させてください。

## 必須 artifact set

各 deploy は、deploy 対象の Git commit をそのまま使い、すべての artifact を `sonari-verifier-runner/<commit>/` 配下へ uploadします。

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
