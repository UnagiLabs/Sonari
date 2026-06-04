# Extending verifier kind runbook

この runbook は 3 例目の `verifier_kind` を追加するときの複製単位と、earthquake 経路の非回帰制約を扱います。

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
