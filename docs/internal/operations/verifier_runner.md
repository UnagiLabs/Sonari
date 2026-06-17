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
| GitHub Actions dev environment、artifact set、手動 deploy | [`docs/deploy.md`](../../../infra/aws/sonari-verifier-runner/docs/deploy.md) |
| Earthquake / membership identity の PCR config、AdminCap transaction、PCR3 | [`docs/pcr-config.md`](../../../infra/aws/sonari-verifier-runner/docs/pcr-config.md) |
| runtime smoke、一気通貫 smoke、詰まりどころ、証跡保存 | [`docs/smoke-runbook.md`](../../../infra/aws/sonari-verifier-runner/docs/smoke-runbook.md) |
| 古い AWS file cleanup、cost/resource 確認、rollback | [`docs/maintenance.md`](../../../infra/aws/sonari-verifier-runner/docs/maintenance.md) |
| 3 例目の `verifier_kind` 追加、earthquake 経路の非回帰制約 | [`docs/extending-verifier-kind.md`](../../../infra/aws/sonari-verifier-runner/docs/extending-verifier-kind.md) |

## 通常の確認順

1. `docs/deploy.md` に従い、対象 commit の artifact set と deploy plan を作る。
2. GitHub Actions deploy workflow、または manual deploy を実行する。
3. `pnpm aws:post-deploy-guardrails` で deployed commit、artifact、stack config を確認する。
4. `pnpm aws:check-idle` で runner ASG、EC2、schedule が idle であることを確認する。
5. `docs/pcr-config.md` に従い、EIF PCR0/1/2 と Sui `VerifierRegistry` の config を照合する。
6. `docs/smoke-runbook.md` に従い、SourceArchiver、earthquake wrapper、ManualWatcher smoke（Floor Census を含む）、membership dummy proof smoke を確認する。
7. smoke 後は DynamoDB/S3 の test residue を cleanup し、最後に `pnpm aws:check-idle` を再実行する。

## 一気通貫 smoke の最低 acceptance

ManualWatcher smoke は、`pnpm aws:smoke:earthquake-manual` の終了だけでは完了判定しません。対象 Step Functions execution が terminal status になった後の DynamoDB row で判定します。

- Step Functions execution が `SUCCEEDED`
- DynamoDB row の `source_archive_status` が `success`
- `relayer_mode` が `submit`
- `relayer_status` が `succeeded`
- `relayer_digest` が non-null
- `disaster_event_object_id` または `relayer_object_id` が non-null
- Floor Census を有効にした smoke では `floor_census_status=succeeded`
- Floor Census を有効にした smoke では `floor_census_digest` が non-null、`floor_census_counts_json` が 3 要素
- SourceArchiver logs に Walrus store success と `registered` / `uploaded` / `certified` がある
- logs に token、private key、secret が出ていない
- `RunnerAutoScalingGroupName` の `DesiredCapacity=0`
- ASG の `InService` instance が `0`
- running EC2 instances が `0`
- `WatcherScheduleName` と `BatchScheduleName` が `DISABLED`

証跡は `.local/sonari-dev/aws-test-results/<run-id>/` に保存します。secret、token、private key は保存しません。

## Floor Census

Floor Census は earthquake relayer submit 成功後に同じ runner instance で Census TEE を起動して実行します。`FLOOR_CENSUS_MODE=submit` のときだけ有効です。`RunnerControlLambda` は Census TEE の `/get_attestation` を取得し、`VerifierRegistry` の census config key `3` / family `5` で enclave instance を登録してから、`/process_data` に Floor Census input bundle と registration metadata を渡します。`accessor::set_floor_census` transaction の送信には既存 relayer Sui Ed25519 鍵 (`RelayerSignerSecretArn`) を使いますが、census BCS payload の raw Ed25519 署名は Census TEE が行います。

Census TEE は `authenticated_event_proof` を必須 input として扱います。TEE は bundle 内の validator committee をそのまま信頼せず、`SONARI_CENSUS_TRUSTED_VALIDATOR_COMMITTEE_DIGEST` に一致する committee だけを trust root として使います。`EventStreamHead`、checkpoint summary、checkpoint signature、EventStreamHead object の OCS commitment、authenticated membership events の replay が一致しない場合は署名しません。

現行の Sui RPC では event-level MMR proof は公開されていません。そのため Sonari は、authenticated event stream の events を `SONARI_AUTHENTICATED_EVENTS_START_CHECKPOINT`（未指定時は 0）から検証対象 checkpoint まで順番に再生し、replay 結果と input snapshot が一致することを TEE 内で検証します。proof material（authenticated events、EventStreamHead object の OCS inclusion proof、checkpoint summary）は `RunnerControlLambda` が Sui の alpha gRPC service（`sui.rpc.alpha.EventService.ListAuthenticatedEvents` / `sui.rpc.alpha.ProofService.GetObjectInclusionProof`）から収集します。validator committee と checkpoint signature は inclusion proof response に含まれないため、v2 `LedgerService`（`GetEpoch` / `GetCheckpoint`）から取得し、`sui_sdk_types` の `ValidatorCommittee` / `ValidatorAggregatedSignature` の正準 BCS に再構成します。GraphQL reader は membership snapshot の取得にだけ使い、proof collector（`SONARI_EVENT_STREAM_HEAD_OBJECT_ID` と gRPC endpoint）が未設定の production submit は fail closed します。

注意（testnet の pruning）: fullnode は authenticated events を一定 checkpoint 数（testnet では概ね数日分）で pruning します。`SONARI_AUTHENTICATED_EVENTS_START_CHECKPOINT` は node の保持範囲（非 pruning 範囲）内、かつ対象 membership stream の最初の event 以前である必要があります。pruning 済み範囲を要求すると EventService が fail closed します。stream genesis が pruning 済みの場合、完全な replay を証明できないため census は意図的に fail closed します。そのため census smoke は fresh membership 作成直後に実行してください。

注意（trusted committee digest の epoch 依存）: `SONARI_CENSUS_TRUSTED_VALIDATOR_COMMITTEE_DIGEST` は検証対象 checkpoint の epoch の validator committee に対応します。committee は epoch ごとに変わるため、census を実行する epoch の committee に一致する digest を pin してください（不一致は fail closed）。digest は `blake2b256("SonariCensusValidatorCommittee::" ‖ ValidatorCommittee_BCS)` を base58 した値で、対象 epoch の committee を独立な情報源で確認してから設定します。

有効化に必要な stack parameter:

- `FloorCensusMode=submit`
- `FloorCensusTarget=<PACKAGE_ID>::accessor::set_floor_census`
- `FloorCensusPauseState=<PauseState object id>`
- `FloorCensusCategoryPool=<CategoryPool object id>`
- `FloorCensusMainPool=<MainPool object id>`
- `RelayerVerifierRegistry=<VerifierRegistry object id>`
- `SonariMembershipRegistryId=<MembershipRegistry object id>`
- `RelayerSignerSecretArn=<relayer Sui private key secret ARN>`
- `CensusTrustedValidatorCommitteeDigest=<trusted Sui validator committee digest>`
- `SonariEventStreamHeadObjectId=<EventStreamHead object id>` は production submit で必須です。membership package の authenticated event stream の EventStreamHead object id で、accumulator root `0xacc` 配下の `Key<EventStreamHead>{ membership package original id }` dynamic field として決定論的に導出できます（`@mysten/sui` の `deriveDynamicFieldID`、type tag `0x2::accumulator::Key<0x2::accumulator_settlement::EventStreamHead>`、key = stream id の 32-byte address）。stream はその package が最初に `event::emit_authenticated` を実行した時点で生成されます。
- `SonariAuthenticatedEventsStartCheckpoint=<checkpoint>` は任意です。authenticated event replay の inclusive start checkpoint で、node の保持範囲内かつ stream の最初の event 以前である必要があります。
- `FloorCensusGraphqlUrl=<Sui GraphQL URL>` は任意です。実行時は `FLOOR_CENSUS_GRAPHQL_URL`、`SONARI_SUI_GRAPHQL_URL`、`RelayerNetwork` default の順に GraphQL endpoint を選びます。stack parameter が空で、`SonariSuiGraphqlUrl` も空の場合は `RelayerNetwork` から default GraphQL URL を使います。

GitHub Actions dev deploy では `SONARI_CENSUS_TRUSTED_VALIDATOR_COMMITTEE_DIGEST` repo variable を `CensusTrustedValidatorCommitteeDigest` parameter に渡します。値を更新した場合は runner stack を redeploy し、runner EC2 の `/opt/sonari/runner.env` にある `SCT` alias と `RunnerControlLambda` env の `SONARI_CENSUS_TRUSTED_VALIDATOR_COMMITTEE_DIGEST` に同じ digest が入っていることを確認します。

同様に `SONARI_EVENT_STREAM_HEAD_OBJECT_ID` / `SONARI_AUTHENTICATED_EVENTS_START_CHECKPOINT` repo variable を `SonariEventStreamHeadObjectId` / `SonariAuthenticatedEventsStartCheckpoint` parameter に渡します。これらは proof material 収集を行う `RunnerControlLambda` の env にだけ反映され、enclave へは配信しません（EventStreamHead object id は proof bundle 経由で TEE に渡り検証されます）。値を更新した場合は runner stack を redeploy します。

初回、または Census EIF の PCR0/1/2 が変わったときは、AdminCap を持つ管理者 wallet で census verifier config を作成または更新します。この wallet は AWS に置きません。作業場所は repository の agent instructions で定めた repo-local admin wallet directory を使います。

1. deploy workflow の run summary から Census EIF PCR0/1/2 を取得する。
2. `metadata_verifier::create_census_verifier_config`、または既存 config への PCR update を実行する。
3. config key が `3`、family が `5`、version が `1` であることを確認する。
4. `CensusTrustedValidatorCommitteeDigest` が対象 network の trust root と一致していることを確認する。
5. smoke 実行時に `RunFloorCensus` が Census TEE の `get_attestation` を登録し、process_data envelope に `registration_metadata.verifier_config_key=3` を渡すことを確認する。

dev smoke では、ManualWatcher で finalized earthquake を作成し、Step Functions が `RecordRelayerSuccess` の後に `RunFloorCensus` を通ることを確認します。DynamoDB row では `floor_census_status=succeeded`、`floor_census_digest` が non-null、`floor_census_counts_json` が 3 要素であることを確認します。Sui 側は `Campaign` の `census_set=true`、`registered_members_by_band`、`floor_ratio_bps` が更新されていることを `sui client object <campaign_id>` などの read-only command で確認します。

## 既知の詰まりどころ

- `Execution Already Exists`: 過去 Step Functions execution name と衝突しています。DynamoDB row を削除すると `retry_count=0` に戻り、`earthquake-<source_event_id>-1` を再利用しようとします。過去 execution の最大 suffix を確認して `retry_count` を調整するか、新しい `source_event_id` を使います。
- `AWS_RUNNER_PROCESS_FAILED` + `metadata_verifier::assert_attestation_pcr_matches` abort code 21: deployed EIF の PCR0/1/2 と Sui `VerifierRegistry` の earthquake config が一致していません。GitHub Actions run summary の `Earthquake EIF PCRs` を使い、AdminCap wallet で `admin::update_earthquake_verifier_config_pcrs` を実行します。
- `scripts/register-verifier-configs.sh`: 既存 config abort 表現の `with code 9` も already registered として扱い、create 失敗後に PCR update へ進みます。

## 変更時の検証

この runbook 群を変更した場合は README test を実行します。

```bash
pnpm exec vitest run scripts/aws_sonari_verifier_runner_readme.test.ts scripts/aws/readme.test.ts --exclude '.codex/**'
```

Move contract-visible behavior、PCR config、schema、payload、署名、artifact build の挙動を変えた場合は、対象 package の test に加えて `pnpm check:move` と関連する root-level check も実行してください。
