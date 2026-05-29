# Sonari 地震検証器

## 概要

地震検証器は、Sonari MVP の地震オラクル実装です。Nautilus / TEE 内で公開地震データを検証し、Sui コントラクトが請求処理向けの災害イベント root を作成するための署名済み finalized payload を生成します。

MVP の対象は地震のみです。津波、浸水、火災、原発事故、その他の二次災害はこの検証器では finalize しません。

## 責務

- Watcher で USGS の地震候補を検出し、DynamoDB にオフチェーン状態を保持する。
- Worker、watcher、relayer、UI、外部 API 応答を信頼せず、TEE 内で source data を再取得して検証する。
- ShakeMap MMI、H3 cell、affected cells、Merkle root、source hash、BCS payload bytes、TEE signature を生成する。
- off-chain processing state として `pending_source`、`pending_mmi`、`rejected`、`ignored_small`、`failed`、`finalized` を返す。
- Sui 投稿対象には署名済み `finalized` payload だけを渡す。

## 信頼境界

信頼境界は署名済み TEE result です。Worker、Lambda、watcher、runner、relayer、UI は候補検出、queue 投入、状態保存、payload 配送を担当できますが、payload の意味を変更してはいけません。

Sui コントラクトは、登録済み地震 verifier key、intent、`oracle_version`、freshness、revision、source、hash、affected cell root、finalized status を検証します。Membership / residence eligibility は `nautilus/verifiers/membership/` の責務です。

`DisasterEvent` や `disaster_event` などの Move 名は、将来の複数災害種類にも対応する disaster relief コントラクトの総称として残します。この地震検証器実装の名前ではありません。

## データソース

- MVP の主要データソースは USGS earthquake detail GeoJSON と ShakeMap `grid.xml.zip`。
- JMA など他の公開地震データは将来追加可能ですが、明示的な source policy として追加する必要があります。
- Magnitude、summary MMI、alert、tsunami flag などの watcher summary fields は runner 起動対象を絞るための screening signal に限定します。Finalization は TEE が再取得した source data と cell-level MMI に基づきます。

## AWS 実行モデル

AWS は処理対象がある時だけ地震検証器を起動します。

1. EventBridge Scheduler が watcher Lambda を起動する。
2. Watcher が USGS recent earthquake feed を scan し、DynamoDB に event state を記録する。
3. 条件を満たした event、または手動投入された event が Step Functions ワークフローを開始する。
4. ワークフローが Auto Scaling Group を `0 -> 1` に scale する。
5. EC2 + Nitro Enclave が本番 TEE command を実行する。
6. 結果を S3 に保存し、DynamoDB state に反映する。
7. ワークフローが ASG を `1 -> 0` に戻す。

通常時は `DesiredCapacity = 0` です。Relayer は preview / dry-run を既定とし、実 submit は明示設定がある場合だけ有効にします。Signer 設定がない場合は fail-closed にします。

CloudFormation テンプレートは `infra/aws/earthquake-runner/README.md` を参照してください。

## ローカル開発

```bash
pnpm --filter @sonari/earthquake-shared test
pnpm --filter @sonari/earthquake-watcher test
pnpm --filter @sonari/earthquake-relayer test
pnpm --filter @sonari/earthquake-runner test
cargo test --manifest-path nautilus/verifiers/earthquake/tee/Cargo.toml
python3 nautilus/verifiers/earthquake/fixtures/verify_fixtures.py
```

ルートからの検証:

```bash
pnpm check
pnpm typecheck
pnpm test
pnpm test:oracle
```

## ディレクトリ構成

```txt
nautilus/verifiers/earthquake/
  README.md
  shared/      TypeScript contract、定数、validator
  tee/         Rust / Nautilus core
  watcher/     candidate scan、state 管理、runner workflow 起動
  runner/      EC2 host service と Nitro Enclave command bridge
  relayer/     Sui preview、dry-run、明示 submit
  fixtures/    USGS fixture と golden output check
```

詳細なコンポーネント説明は各サブディレクトリの README に置きます。

## 出力

TEE の出力は次のいずれかです。

- `pending_source`: source または ShakeMap がまだ利用できない。
- `pending_mmi`: source はあるが利用可能な MMI grid data がまだない。
- `rejected`: source は検証済みだが claimable affected cells を生成できない。
- `finalized`: affected cells root、artifact hash、BCS bytes、公開鍵、signature を含む署名済み地震オラクル payload。

Sui 投稿対象になるのは `finalized` 出力だけです。

## プライバシー / セキュリティ

- この検証器は個人の residence、student、phone、GPS、address、document evidence を扱いません。
- 生の地震 source artifact は hash 化し、必要に応じて Walrus-backed reference として archive します。
- TEE signing key は本番 TEE boundary 内に隔離します。
- Watcher と relayer の入力は contract boundary では untrusted として扱います。
- Source fetch、archive verification、BCS serialization、Merkle generation、signing の失敗は fail-closed にします。

## 今後の作業

- JMA など他の公開地震 feed を明示的に versioned source policy として追加する。
- 新しい ShakeMap format は fixture と golden vector を追加してから対応する。
- 単一 region MVP が安定した後に multi-region runner fallback を追加する。
- pending、rejected、failed、finalized state の運用 dashboard を追加する。
- 検証器ファミリー間で重複が見えた時点で runner / relayer utility の共通化を検討する。
