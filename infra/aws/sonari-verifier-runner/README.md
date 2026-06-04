# Sonari verifier runner AWS runbook

この stack は、地震検証と membership identity 検証を 1 つの AWS runner capacity pool で実行します。この README は入口です。実行手順の詳細は `docs/` 配下へ分けています。

## 最初に確認すること

- すべての AWS command は account `595103996064` で実行します。
- 手動 deploy でも artifact parameter は `scripts/aws_sonari_verifier_runner_deploy_plan.ts` が出す `parameterOverrideArgs` だけを使います。artifact key、checksum、`GitCommitSha`、`ScheduleState` を手で組み立ててはいけません。
- 各 deploy artifact は deploy 対象 commit をそのまま使い、`sonari-verifier-runner/<commit>/` 配下へ upload します。
- GitHub Actions の dev environment は `aws-sonari-verifier-runner-dev` です。AWS 側 resource ARN は environment variables に置けますが、token、private key、wallet config は置きません。
- SourceArchiver は Lambda 側の Walrus SDK upload path だけを使います。TEE と runner EC2 に Walrus wallet、config、store 用 secret は置きません。
- AdminCap を持つ管理者 wallet は AWS Runner、EC2、Lambda、SSM、AWS Secrets Manager に置きません。Relayer wallet と SourceArchiver hot wallet は AdminCap を持ちません。
- `RELAYER_MODE` / `RELAYER_NETWORK` など `RELAYER_*` namespace は earthquake 専用です。新しい verifier kind を追加しても改名、流用しません。

AWS account の gate:

```bash
EXPECTED_ACCOUNT_ID=595103996064
ACTUAL_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
test "$ACTUAL_ACCOUNT_ID" = "$EXPECTED_ACCOUNT_ID"
```

## 詳細 runbook

| 目的 | 参照先 |
| --- | --- |
| GitHub Actions dev environment、artifact set、手動 deploy | [`docs/deploy.md`](docs/deploy.md) |
| Earthquake / membership identity の PCR config、AdminCap transaction、PCR3 | [`docs/pcr-config.md`](docs/pcr-config.md) |
| runtime smoke、一気通貫 smoke、詰まりどころ、証跡保存 | [`docs/smoke-runbook.md`](docs/smoke-runbook.md) |
| 古い AWS file cleanup、cost/resource 確認、rollback | [`docs/maintenance.md`](docs/maintenance.md) |
| 3 例目の `verifier_kind` 追加、earthquake 経路の非回帰制約 | [`docs/extending-verifier-kind.md`](docs/extending-verifier-kind.md) |

## 通常の確認順

1. `docs/deploy.md` に従い、対象 commit の artifact set と deploy plan を作る。
2. GitHub Actions deploy workflow、または manual deploy を実行する。
3. `pnpm aws:post-deploy-guardrails` で deployed commit、artifact、stack config を確認する。
4. `pnpm aws:check-idle` で runner ASG、EC2、schedule が idle であることを確認する。
5. `docs/pcr-config.md` に従い、EIF PCR0/1/2 と Sui `VerifierRegistry` の config を照合する。
6. `docs/smoke-runbook.md` に従い、SourceArchiver、earthquake wrapper、ManualWatcher smoke、membership dummy proof smoke を確認する。
7. smoke 後は DynamoDB/S3 の test residue を cleanup し、最後に `pnpm aws:check-idle` を再実行する。

## 一気通貫 smoke の最低 acceptance

ManualWatcher smoke は、`pnpm aws:smoke:earthquake-manual` の終了だけでは完了判定しません。対象 Step Functions execution が terminal status になった後の DynamoDB row で判定します。

- Step Functions execution が `SUCCEEDED`
- DynamoDB row の `source_archive_status` が `success`
- `relayer_mode` が `submit`
- `relayer_status` が `succeeded`
- `relayer_digest` が non-null
- `disaster_event_object_id` または `relayer_object_id` が non-null
- SourceArchiver logs に Walrus store success と `registered` / `uploaded` / `certified` がある
- logs に token、private key、secret が出ていない
- `RunnerAutoScalingGroupName` の `DesiredCapacity=0`
- ASG の `InService` instance が `0`
- running EC2 instances が `0`
- `WatcherScheduleName` と `BatchScheduleName` が `DISABLED`

証跡は `.local/sonari-dev/aws-test-results/<run-id>/` に保存します。secret、token、private key は保存しません。

## 既知の詰まりどころ

- `Execution Already Exists`: 過去 Step Functions execution name と衝突しています。DynamoDB row を削除すると `retry_count=0` に戻り、`earthquake-<source_event_id>-1` を再利用しようとします。過去 execution の最大 suffix を確認して `retry_count` を調整するか、新しい `source_event_id` を使います。
- `AWS_RUNNER_PROCESS_FAILED` + `metadata_verifier::assert_attestation_pcr_matches` abort code 21: deployed EIF の PCR0/1/2 と Sui `VerifierRegistry` の earthquake config が一致していません。GitHub Actions run summary の `Earthquake EIF PCRs` を使い、AdminCap wallet で `admin::update_earthquake_verifier_config_pcrs` を実行します。
- `scripts/register-verifier-configs.sh`: 現行 Sui CLI の既存 config abort 表現が `with code 9` の場合、already registered 判定に引っかからない可能性があります。その場合は PCR update を直接実行するか、script の判定を別途改修します。

## 変更時の検証

この runbook 群を変更した場合は README test を実行します。

```bash
pnpm exec vitest run scripts/aws_sonari_verifier_runner_readme.test.ts scripts/aws/readme.test.ts --exclude '.codex/**'
```

Move contract-visible behavior、PCR config、schema、payload、署名、artifact build の挙動を変えた場合は、対象 package の test に加えて `pnpm check:move` と関連する root-level check も実行してください。
