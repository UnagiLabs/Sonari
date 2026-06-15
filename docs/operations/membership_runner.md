# Membership identity AWS runner 運用手順

この文書は、membership identity AWS runner の運用 runbook です。local artifact build から AWS deploy、World ID verification、VerifierRegistry registration、TEE result 確認までの手順を扱います。

AWS credential、World ID app / proof input、VerifierRegistry registration 用の Sui 設定、Sui signer material がない場合、real registration は確認できません。不足がある場合は、該当 gate で止め、blocker を evidence template に記録してください。

Evidence template は `infra/aws/membership-identity-runner/evidence-template.md` です。

## Job モデル

Identity verification request は queued job として扱います。処理対象 job がない場合、EC2 + Nitro capacity は zero のままです。

```text
SubmitVerification Lambda -> verification_jobs DynamoDB -> BatchVerifier Lambda -> Step Functions -> EC2 + Nitro
```

この PR の dapp 連携範囲は、`SubmitVerification` に request を POST し、`verification_jobs.status=queued` の job を作るところまでです。`BatchVerifier` による TEE 実行、VerifierRegistry registration、TEE result 確認は後続の運用 gate として扱います。

```mermaid
flowchart TD
  Submit[SubmitVerification Lambda]
  Jobs[verification_jobs DynamoDB]
  Batch[BatchVerifier Lambda]
  Empty{queued job exists}
  Workflow[Step Functions]
  Enclave[EC2 + Nitro]
  Tee[membership-tee server]
  Attestation[/get_attestation]
  Process[/process_data]
  Result[Identity TEE result JSON]

  Submit --> Jobs
  Batch --> Jobs
  Batch --> Empty
  Empty -->|no| Stop[do not start enclave]
  Empty -->|yes| Workflow
  Workflow --> Enclave
  Enclave --> Tee
  Tee --> Attestation
  Attestation --> Process
  Process --> Result
```

## 信頼境界

worker は request 作成と状態管理を担当します。worker は TEE stdout の意味を変えてはいけません。

TEE は検証、正規化、署名を担当します。TEE は stdin の `IdentityVerifyRequest` を検証し、stdout に status 付き JSON を 1 つ返します。

relayer は結果を配送するだけです。relayer は payload の意味を変更してはいけません。Move contract は署名済み verified payload だけを信頼します。

## 固定 TEE interface

AWS / Nautilus production entrypoint は次の command です。

```bash
membership-tee server
```

`membership-tee server` は VSOCK HTTP server として待ち受けます。
server path は起動時に enclave-local ephemeral key を作ります。
AWS runner は `/get_attestation` を呼び、attestation public key を取得します。
submit-capable relayer 設定がある場合、runner は Sui 上の enclave registration を使います。
default / dry-run smoke では、runner は `/process_data` envelope 用の local registration metadata を作ります。
runner は `/process_data` に `IdentityVerifyRequest` と registration metadata を送ります。
server は verified result に signature、public_key、registration metadata を入れて返します。

`membership-tee production` は legacy/local stdin/stdout route です。
AWS / Nautilus production の source of truth ではありません。
legacy/local route は stdin に `IdentityVerifyRequest` JSON value を 1 つ受け取り、stdout に JSON value を 1 つ返します。
この 1 request = 1 JSON in / 1 JSON out の contract は変えません。

World ID API base は canonical value を使い、egress は `egress_proxy_url` / `SONARI_WORLD_ID_EGRESS_PROXY_URL` で渡す。
server path の canonical World ID API base は `https://developer.world.org` です。
bootstrap JSON は `world_id_app_id` と `egress_proxy_url` を渡します。
`world_id_api_base` は互換のため wire 上に残りますが、server path はこの値を production source of truth として使いません。
runner env は `SONARI_WORLD_ID_EGRESS_PROXY_URL` を TEE process env に入れます。

World ID v4 では `rp_id` が canonical な識別子です。runner env は `SONARI_WORLD_ID_RP_ID` を TEE process env に出力します。
environment は `production` または `staging` を選びます。runner env は `SONARI_WORLD_ID_ENVIRONMENT` を TEE process env に出力します。
production の egress 正規ホストは `https://developer.world.org` の :443 のみ許可します。
staging の egress 正規ホストは `https://staging-developer.worldcoin.org` の :443 のみ許可します。
egress allowlist は選んだ environment のホストに絞ります。
mainnet と staging の組み合わせは起動時に fail-closed で拒否します。
enclave 起動時が一次防御です。AWS UserData の deploy 時 exit が補助的に同じ制約を強制します。
`WorldIdAppId` は legacy 互換のみです。`WorldIdApiBase` は server path の source of truth ではありません。

Status は次の値に固定します。

```text
verified
rejected
pending_source
unsupported
```

`pending_source` は earthquake verifier と同じ再試行用の語です。運用ツールは同じ語を見て retry や監視を組み立てられます。

AWS 境界 interface として固定する env は次の 3 つです。

```text
SONARI_TEE_SIGNING_KEY_SEED
SONARI_TEE_SIGNING_KEY_SEED_FILE
SONARI_WORLD_ID_API_BASE
```

この 3 つは legacy/local stdin/stdout 互換の固定 interface として残ります。
server path では signing seed を使いません。
`SONARI_WORLD_ID_API_BASE` は deploy compatibility の parameter として残りますが、server path は canonical base を使います。
`SONARI_WORLD_ID_APP_ID` は production runtime config です。
AWS では deploy config から TEE process env に注入します。
`SONARI_WORLD_ID_EGRESS_PROXY_URL` は runner bootstrap が作る enclave egress proxy URL です。
Signing seed は Lambda や EC2 host に平文で注入してはいけません。本番 signing material は暗号化し、KMS / Nitro attestation measurement を通してのみ decrypt します。

## 必須 artifact

deploy 前に次を build し、保持します。

- `dist/aws/membership-identity-tee-artifact.tar.gz`
- `dist/aws/membership-identity-tee-artifact.tar.gz.sha256`
- `dist/aws/membership-identity-tee.eif`
- `dist/aws/membership-identity-tee.eif.sha256`、または build / deploy system から取得した同等の EIF checksum
- `LambdaCodeS3Bucket` と `LambdaCodeS3Key` 用に S3 upload した Lambda code bundle
- `SigningSeedCiphertextS3Bucket` と `SigningSeedCiphertextS3Key` 用に S3 upload した encrypted signing material

Membership artifact は `scripts/build_aws_membership_identity_tee_artifact.ts` から build します。この script は earthquake 側の reference である `scripts/build_aws_earthquake_tee_artifact.ts` に従います。

```bash
pnpm build:aws-membership-identity-tee-artifact
pnpm build:aws-membership-identity-eif
sha256sum -c dist/aws/membership-identity-tee-artifact.tar.gz.sha256
```

Cargo manifest:

```text
nautilus/verifiers/membership/tee/Cargo.toml
```

Default target:

```text
x86_64-unknown-linux-musl
```

Artifact command:

```bash
bin/membership-tee server
```

Walrus CLI を含めません。membership TEE は Walrus を呼びません。stdin/stdout 契約は変えません。

## KMS / Nitro attestation measurement の取得

Stack parameter を deploy する前に、EIF identity を取得します。

- EIF identity
- ImageSha384
- PCR3

Target AMI 上で `nitro-cli build-enclave` output、または利用可能な Nitro CLI inspection command から measurement を取得します。CloudFormation template は次の条件で KMS decrypt を gate します。

```text
NitroEnclaveImageSha384
NitroEnclavePcr3
kms:RecipientAttestation:ImageSha384
kms:RecipientAttestation:PCR3
```

Placeholder measurement で deploy してはいけません。不一致は encrypted signing material の decrypt を防ぎ、fail-closed になる必要があります。

## 必須 operator input

### World ID app / proof input

mainnet live smoke では real World ID proof input を使います。

- `SONARI_WORLD_ID_APP_ID`: legacy 互換のみ
- `SONARI_WORLD_ID_API_BASE`: deploy compatibility 用。server path は `https://developer.world.org` を canonical base として使う
- `SONARI_WORLD_ID_RP_ID`: World ID v4 の canonical な識別子 rp_id。Stack parameter `WorldIdRpId` から TEE process env に注入する
- `SONARI_WORLD_ID_ENVIRONMENT`: `production` または `staging`。Stack parameter `WorldIdEnvironment` から TEE process env に注入する
- `SONARI_WORLD_ID_EGRESS_PROXY_URL`: enclave path 内の vsock-proxy endpoint
- `world_id.world_app_id`
- `world_id.nullifier_hash`
- `world_id.merkle_root`
- `world_id.proof`
- `world_id.verification_level`
- `world_id.action`: `sonari_membership_register_v<N>` 形式の action
- `world_id.signal_hash`

request には `registry_id`、`membership_id`、`owner`、`terms_version`、`signed_statement_hash` も含める必要があります。
`registry_id` は stack の `SonariIdentityRegistryId` / Lambda env の `SONARI_IDENTITY_REGISTRY_ID` と一致する必要があります。
一致しない request は `verification_jobs` に保存せず、HTTP 400 で fail-closed します。

### dapp からの queue 投入

AWS stack は `SubmitVerificationFunctionUrlOutput` に dapp 用の POST endpoint を出力します。この endpoint は public Function URL です。`AuthType: NONE` のため、Lambda 側の schema validation、unknown field 拒否、`registry_id` 照合を fail-closed の入口防御として扱います。

AWS stack は `IdentityStatusLambdaUrlOutput` に dapp 用の status endpoint も出力します。この endpoint も public Function URL ですが、Lambda は wallet personal message 署名を検証してから status を返します。ブラウザに AWS credential、DynamoDB table 名、queue 名は渡しません。

dapp には次の build-time env を設定します。

```text
NEXT_PUBLIC_SONARI_IDENTITY_SUBMIT_URL=<SubmitVerificationFunctionUrlOutput>
NEXT_PUBLIC_SONARI_IDENTITY_STATUS_URL=<IdentityStatusLambdaUrlOutput>
NEXT_PUBLIC_SONARI_IDENTITY_REGISTRY_ID=<SonariIdentityRegistryId>
```

dapp は documented schema の field だけを送信します。private key、AWS secret、raw KYC image、raw document image は送信しません。`provider=kyc` の request では `world_id` field を省略します。

### Stack parameter

AWS deployment には、少なくとも次の stack parameter が必要です。

- `VpcId`
- `SubnetIds`
- `InstanceType`
- `AmiId`
- `LambdaCodeS3Bucket`
- `LambdaCodeS3Key`
- `TeeArtifactS3Bucket`
- `TeeArtifactS3Key`
- `TeeArtifactSha256`
- `TeeEifS3Bucket`
- `TeeEifS3Key`
- `TeeEifSha256`
- `NitroEnclaveCpuCount`
- `NitroEnclaveMemoryMiB`
- `NitroEnclaveCid`
- `SigningSeedCiphertextS3Bucket`
- `SigningSeedCiphertextS3Key`
- `NitroEnclaveImageSha384`
- `NitroEnclavePcr3`
- `WorldIdAppId`: legacy 互換のみ
- `WorldIdApiBase`: deploy compatibility 用。server path は canonical base を使う
- `WorldIdRpId`: 必須。World ID v4 の canonical な識別子 rp_id。legacy の WorldIdAppId を置き換える
- `WorldIdEnvironment`: `production` または `staging`。Default `production`。egress allowlist のホストを選ぶ
- `ScheduleState`
- `GitCommitSha`

Launch template の user data は、AWS Nitro Enclaves allocator の `/etc/nitro_enclaves/allocator.yaml` を `NitroEnclaveCpuCount` / `NitroEnclaveMemoryMiB` に合わせて更新し、`nitro-enclaves-allocator.service` を restart します。`nitro-cli run-enclave --memory` より小さい hugepage 予約で instance を起動してはいけません。

### Sui dry-run / submit / registration config

MembershipPass の identity payload dry-run には次が必要です。
dry-run は Sui に transaction を submit しません。
ただし Move VM で reject された場合は fail-closed で止まります。

- `IDENTITY_RELAYER_MODE=dry_run`
- `SONARI_IDENTITY_PACKAGE_ID`
- `SONARI_IDENTITY_PAUSE_STATE_ID`
- `SONARI_IDENTITY_REGISTRY_ID`
- `SONARI_MEMBERSHIP_REGISTRY_ID`
- `SONARI_VERIFIER_REGISTRY_ID`
- `SONARI_SUI_CLOCK_ID`
- `RELAYER_NETWORK`: 例 `testnet`
- `RELAYER_GRPC_URL`
- `RELAYER_SENDER_ADDRESS`

MembershipPass への本 submit と readback には追加で次が必要です。
submit は real transaction です。
dry-run 成功後だけ submit へ進みます。

- `IDENTITY_RELAYER_MODE=submit`
- `RELAYER_ALLOW_SUBMIT=true`
- `RELAYER_SIGNER_SECRET_ARN`

VerifierRegistry への enclave registration も同じ submit 設定を使います。
registration は real submit です。
dry-run だけでは登録済み enclave metadata を作れません。

dry-run 成功時は signed payload、Sui request、transaction bytes、effects を
verification job row に保存します。
submit 成功時は tx digest を job row に保存します。
その後、同じ Sui network から MembershipPass を読み戻します。
readback が submitted payload と一致した場合だけ completed にします。
readback が失敗した場合も tx digest は保存し、job は failed にします。

## 運用 runbook

### 1. Local unit test

Artifact を upload する前に local unit test を実行します。

```bash
pnpm exec vitest run scripts/membership_identity_aws_interface_doc.test.ts
pnpm exec vitest run scripts/aws_membership_identity_tee_artifact_build.test.ts scripts/aws_membership_identity_eif_build.test.ts scripts/aws_membership_identity_runner_template.test.ts
pnpm --filter @sonari/membership-verifier-runner test
cargo test -p membership-tee
```

Command、exit code、関連 log path を evidence template に記録します。

### 2. Artifact build、checksum、upload

tar と EIF を build し、tar checksum を検証し、必須 artifact を S3 に upload します。

```bash
pnpm build:aws-membership-identity-tee-artifact
pnpm build:aws-membership-identity-eif
sha256sum -c dist/aws/membership-identity-tee-artifact.tar.gz.sha256
```

tar artifact checksum、EIF checksum、EIF identity、ImageSha384、PCR3 を記録します。

### 3. AWS stack の deploy または update

Evidence file または secure parameter storage からすべての stack parameter を解決して deploy します。

```bash
aws cloudformation deploy \
  --template-file infra/aws/membership-identity-runner/template.yaml \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    VpcId="$VPC_ID" \
    SubnetIds="$SUBNET_IDS" \
    AmiId="$AMI_ID" \
    LambdaCodeS3Bucket="$LAMBDA_CODE_S3_BUCKET" \
    LambdaCodeS3Key="$LAMBDA_CODE_S3_KEY" \
    TeeArtifactS3Bucket="$TEE_ARTIFACT_S3_BUCKET" \
    TeeArtifactS3Key="$TEE_ARTIFACT_S3_KEY" \
    TeeArtifactSha256="$TEE_ARTIFACT_SHA256" \
    TeeEifS3Bucket="$TEE_EIF_S3_BUCKET" \
    TeeEifS3Key="$TEE_EIF_S3_KEY" \
    TeeEifSha256="$TEE_EIF_SHA256" \
    SigningSeedCiphertextS3Bucket="$SIGNING_SEED_CIPHERTEXT_S3_BUCKET" \
    SigningSeedCiphertextS3Key="$SIGNING_SEED_CIPHERTEXT_S3_KEY" \
    NitroEnclaveImageSha384="$NITRO_ENCLAVE_IMAGE_SHA384" \
    NitroEnclavePcr3="$NITRO_ENCLAVE_PCR3" \
    WorldIdAppId="$SONARI_WORLD_ID_APP_ID" \
    WorldIdApiBase="$SONARI_WORLD_ID_API_BASE" \
    WorldIdRpId="$SONARI_WORLD_ID_RP_ID" \
    WorldIdEnvironment="$SONARI_WORLD_ID_ENVIRONMENT" \
    GitCommitSha="$(git rev-parse HEAD)"
```

### 4. AWS deployment smoke

Deploy 後、stack output を読み、private control plane が存在することを確認します。

```bash
aws cloudformation describe-stacks --stack-name "$STACK_NAME"
aws dynamodb describe-table --table-name "$VERIFICATION_JOBS_TABLE_NAME"
aws lambda get-function --function-name "$SUBMIT_VERIFICATION_LAMBDA_NAME"
aws lambda get-function --function-name "$BATCH_VERIFIER_LAMBDA_NAME"
aws stepfunctions describe-state-machine --state-machine-arn "$RUNNER_STATE_MACHINE_ARN"
```

Stack name、output name、smoke result を記録します。

### 5. Nitro Enclave start

Queued job を 1 つ trigger し、workflow が EC2 capacity を起動し、Nitro Enclave を起動し、完了または失敗後に capacity を zero に戻すことを確認します。

```bash
aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names "$RUNNER_AUTO_SCALING_GROUP_NAME"
aws stepfunctions list-executions \
  --state-machine-arn "$RUNNER_STATE_MACHINE_ARN" \
  --max-results 5
```

Instance 上では、runner command が設定済み CPU、memory、CID、EIF path で `nitro-cli run-enclave` を使います。

### 6. vsock-proxy World ID real API smoke

Real World ID request を submit し、enclave が vsock-proxy 経由でのみ World ID API に到達することを確認します。Proxy failure は fail-closed error または `pending_source` を返す必要があります。host 側で直接 proof を受け入れる fallback があってはいけません。

記録するもの:

- World ID app id
- redacted proof request id または job id
- TEE stdout status
- verified output の public key
- sanitized CloudWatch log location

### 7. VerifierRegistry registration、TEE result、Sui submit

この dedicated stack は `membership-tee server` の attestation、World ID verification、`/process_data` envelope を確認する runner です。
default / dry-run smoke では、runner は envelope 用の local registration metadata を使います。
submit-capable registration 設定（`IDENTITY_RELAYER_MODE=submit`、`RELAYER_ALLOW_SUBMIT=true`、`RELAYER_SIGNER_SECRET_ARN`）がある場合だけ、Sui 上の enclave registration を使います。
この registration は real submit です。
`tx_digest` は VerifierRegistry 登録 proof ではありません。
TEE-only completion では `tee-result:<sha256>` の digest が job に残ります。
verified result では、runner は `accessor::update_identity_verification` の dry-run を実行します。
dry-run が失敗した場合、job は failed になり、`apply_result` には進みません。
dry-run が成功した場合、job row に `sui_dry_run_result_json` と `sui_dry_run_completed_at_ms` が残ります。
`IDENTITY_RELAYER_MODE=submit` では、runner は保存済み dry-run handoff と verified result を照合してから submit します。
submit 後は MembershipPass を readback し、submitted payload の反映を確認します。
testnet 一気通貫の成功条件は、後述の「dummy World ID + Sui testnet 一気通貫 smoke」にまとめます。

記録するもの:

- registration metadata の `verifier_config_key`
- registration metadata の `enclave_instance_public_key`
- verified result の `payload_bcs_hex`
- verified result の `signature`
- verified result の `public_key`
- non-verified result に `signature` が無いこと
- non-verified result に `public_key` が無いこと
- dry-run result の `sui_dry_run_completed_at_ms`
- dry-run result の signed payload / request / transaction bytes
- dry-run failure が job failed になったこと
- submit result の `tx_digest`
- readback の membership pass object id
- readback の identity verified flag
- readback の provider mask
- readback の verified / expires timestamp
- readback の terms version
- readback の signed statement hash
- readback failure でも tx digest が job row に残ること

## dummy World ID + Sui testnet 一気通貫 smoke

この節は MVP のゴールを 1 か所にまとめます。MVP では、本物の World ID API 検証は行いません。代わりに、テスト用の本人確認データを使い、testnet で本人確認を最後まで通すことを目標にします。real World ID proof の live gate と KYC は MVP の対象外です。

### dummy World ID proof の network 制限

dummy World ID proof は testnet / devnet 指定時のみ使えます。mainnet では deploy 前に拒否します。ここでいう dummy World ID proof とは、本物の World ID API を確認する代わりに、検証済みと同じ形をしたテスト用の proof（本人確認データ）を流す運用のことです。

この制限は `pnpm identity:live-gate`（`scripts/membership_identity_live_gate.ts`）が強制します。`RELAYER_NETWORK=mainnet` で dummy を選ぶと、live gate が fail-closed（安全側に倒して停止）で止めます。dummy proof smoke の具体手順は、共有 runbook `infra/aws/sonari-verifier-runner/docs/smoke-runbook.md` の「Membership dummy proof smoke」を参照します。

### Sui testnet object の用意

testnet 一気通貫には Sui dry-run / registration config が必要です。
「Sui dry-run / registration config」節の env を、次のどちらかで埋めます。

- 必要な Sui testnet object を新規に作る。
- 既存 object を検出して、その object ID を割り当てる。

どちらの場合も、`SONARI_VERIFIER_REGISTRY_ID` は対象 testnet の VerifierRegistry object と一致させます。一致しない object を使うと、enclave registration は fail-closed で止まります。

### smoke の成功条件

testnet 一気通貫の smoke は、次をすべて満たしたときに成功とします。

- Step Functions 実行が `SUCCEEDED` に到達する。
- registration metadata に `verifier_config_key=2` が残る。
- registration metadata に `enclave_instance_public_key` が残る。
- verified result に `payload_bcs_hex`、`signature`、`public_key` が残る。
- non-verified result に `signature` と `public_key` が無い。
- AWS idle cleanup が効く。run 後に capacity が zero に戻ります。`DesiredCapacity=0`、ASG の `InService=0`、running EC2 instances が `0`、schedule が `DISABLED` になることを確認します。

### KYC の扱い

KYC は MVP 外です。`provider=kyc` の request は現在 `unsupported` を返し、error code は `KYC_UNSUPPORTED` です。MVP では World ID provider だけを通します。

## Evidence gate

Live run 中に `evidence-template.md` を埋めます。Close-out に必要な最小 evidence は次の通りです。

- stack name
- artifact checksum
- EIF identity
- ImageSha384
- PCR3
- public key
- tx digest
- post-tx readback

Credential がない場合、この issue は close できません。
