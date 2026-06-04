# AWS test scripts

AWS dev stack の確認は、ad hoc AWS CLI ではなくこの directory の script を優先します。対象は verification と smoke で、CloudFormation deploy や old artifact deletion は v1 の通常 script には含めません。

一気通貫 smoke の運用順序、acceptance、失敗時の切り分けは `infra/aws/sonari-verifier-runner/docs/smoke-runbook.md` の `Earthquake manual smoke の実行ノウハウ` を参照してください。

## 何を実行するか

- 状態確認だけ: `pnpm aws:inventory -- --stack sonari-verifier-runner-dev`
- dev stack 作業前の fail-closed 確認: `pnpm aws:preflight -- --stack sonari-verifier-runner-dev`
- idle assertion: `pnpm aws:check-idle -- --stack sonari-verifier-runner-dev`
- earthquake runner wrapper のみ: `pnpm aws:verify:earthquake-wrapper -- --stack sonari-verifier-runner-dev`
- SourceArchiver Lambda の Walrus config materialize のみ: `pnpm aws:verify:source-archiver -- --stack sonari-verifier-runner-dev`
- manual watcher workflow smoke: `pnpm aws:smoke:earthquake-manual -- --stack sonari-verifier-runner-dev`
- deploy 後の local guardrails 再実行: `pnpm aws:post-deploy-guardrails -- --stack sonari-verifier-runner-dev`

## Invariants

- default account は `595103996064`、default stack は `sonari-verifier-runner-dev` です。
- runner を起動する script は cleanup を持ち、成功/失敗に関係なく ASG desired capacity を `0` に戻します。
- cleanup 後は ASG instance list empty、pending/running EC2 none、Watcher/Batch schedules `DISABLED` を確認します。
- SSM `--parameters commands=...` shorthand を使わないでください。multiline command は必ず JSON parameters file 形式で渡します。
- SSM Online は bootstrap 完了ではありません。`/opt/sonari/bootstrap-complete` marker を別 gate として確認します。

## Script boundaries

- `aws:verify:earthquake-wrapper` は ASG を `0 -> 1 -> 0` にします。`/opt/sonari/bin/run-earthquake-enclave` の `health_check`、`get_attestation`、`process_data` を SSM 経由で確認します。
- `aws:verify:source-archiver` は runner ASG を起動しません。小さい source artifact を result bucket に置き、expected Walrus blob id を計算し、SourceArchiver Lambda を直接 invoke して `source_archiver.walrus_store.success` と secret 非露出を CloudWatch logs で確認します。最後に idle assertion を実行します。
- `aws:smoke:earthquake-manual` は ManualWatcher Lambda URL に `source_event_id` を POST し、Step Functions execution と DynamoDB row の概要を確認します。出力の `source_archive_summary` で `source_archive_status`、`relayer_mode`、`relayer_digest`、`disaster_event_object_id` を確認します。relayer submit は既存 stack config に依存するため、起動時に明示表示します。
- `aws:post-deploy-guardrails` は Git commit、artifact S3 keys、Lambda code metadata、ASG idle、schedule disabled を確認します。
- old S3 artifact cleanup と CloudFormation deploy はここでは実行しません。deploy は既存 workflow と `scripts/aws_sonari_verifier_runner_deploy_plan.ts` を source of truth とします。
