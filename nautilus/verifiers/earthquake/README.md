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

Sui コントラクトは、登録済み enclave instance の公開鍵、intent、`oracle_version`、freshness、revision、source、hash、affected cell root、finalized status を検証します。Membership / residence eligibility は `nautilus/verifiers/membership/` の責務です。

地震 verifier は Nautilus の考え方に合わせ、2 つの identity を分けます。

| Identity | 意味 | 変わるタイミング |
| --- | --- | --- |
| Verifier identity | `Earthquake Oracle v1` のような検証ロジック単位。許可 PCR と version を持つ。 | verifier code、allowed endpoint、runtime 設定を変えて PCR を更新した時 |
| Enclave instance identity | 1 回起動した Nitro Enclave。attestation document 内の公開鍵で表す。 | EC2 / enclave を起動するたび |

DisasterEvent は `VerifierConfig` と `EnclaveInstance` を保存します。これにより、地震 A と地震 B が別々の ephemeral public key で署名されても、同じ許可 PCR の `Earthquake Oracle v1` として追跡できます。

Nautilus 由来の責務は、HTTP endpoint ではなく SSM command で実行する場合も同じです。

| 責務 | Sonari での意味 |
| --- | --- |
| `health_check` | TEE が必要な source、特に USGS detail GeoJSON と ShakeMap artifact に到達できることを確認する。 |
| `get_attestation` | enclave 内で生成した一時公開鍵と、その公開鍵を含む Nitro attestation document を返す。 |
| `process_data` | TEE 内で USGS / ShakeMap を再取得し、BCS payload を作り、attested public key に対応する秘密鍵で署名する。 |

本番判定では、`get_attestation` と `process_data` が同じ enclave instance の鍵を使う必要があります。Host が用意した固定 seed、debug key、または env 経由の fake attestation document で代替してはいけません。

`DisasterEvent` や `disaster_event` などの Move 名は、将来の複数災害種類にも対応する disaster relief コントラクトの総称として残します。この地震検証器実装の名前ではありません。

## データソース

- MVP の主要データソースは USGS earthquake detail GeoJSON と ShakeMap `grid.xml.zip`。
- JMA など他の公開地震データは将来追加可能ですが、明示的な source policy として追加する必要があります。
- Magnitude、summary MMI、alert、tsunami flag などの watcher summary fields は runner 起動対象を絞るための screening signal に限定します。Finalization は TEE が再取得した source data と cell-level MMI に基づきます。

## PCR と allowed endpoints

`VerifierConfig` は PCR0 / PCR1 / PCR2 を 48 byte の SHA-384 measurement として保持します。これらは enclave image、kernel / ramdisk、runtime 設定を表す指紋です。Move の本番 API は all-zero PCR を拒否します。

次を変えた場合は、新しい PCR を取得し、`VerifierConfig` version を更新してから AWS submit を有効化します。

- 地震 TEE Rust binary
- enclave image / Dockerfile / bootstrap entrypoint
- USGS や Walrus などの外部接続先を許可する設定
- enclave が読む runtime 設定のうち measurement に入るもの

現在の地震 source policy は、少なくとも次の endpoint を明示的に許可する前提です。

- `https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/<event-id>.geojson`
- USGS detail GeoJSON が参照する ShakeMap `download/grid.xml.zip`
- USGS detail GeoJSON が参照する ShakeMap `download/grid.xml`
- Walrus archive を使う場合の configured aggregator / publisher endpoint

許可 endpoint を追加する場合は、source policy、PCR 再現手順、Move の許可 PCR を同じ変更として扱います。

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

CloudFormation テンプレートは `infra/aws/sonari-verifier-runner/README.md` を参照してください。

AWS dev 確認では、次をすべて満たすまで完了扱いにしません。

- artifact build と stack deploy が成功する。
- EC2 と Nitro Enclave が request 時だけ起動する。
- enclave 内で一時署名鍵を生成する。
- Nitro attestation document を取得し、Sui testnet で `EnclaveInstance` を登録する。
- 登録した enclave 公開鍵で署名した finalized payload だけが `DisasterEvent` を作成する。
- workflow 完了後に ASG `DesiredCapacity`、InService instance、running EC2 が 0 になる。
- CloudWatch、Step Functions、Lambda、runner logs に未解決 error が残らない。

地震 AWS path は、上記を実環境で確認してから submit mode にします。ローカル fixture や fake attestation で通した結果を、この dev 確認の代替にしてはいけません。

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
- 生の地震 source artifact は TEE 内で hash 化し、`walrus blob-id --n-shards "$SONARI_WALRUS_N_SHARDS"` で Walrus の content-addressed blob id を計算して署名対象 manifest に入れます。TEE は保存を待たず、Walrus への実保存、pin、retry、fetch 再検証は TEE 外の archiver が担います。初期値の `SONARI_WALRUS_N_SHARDS=1000` は対象 Walrus network の shard count と一致必須です。network、protocol、shard count を変更する場合は VerifierConfig version、PCR、source policy も同時に更新します。
- TEE signing key は本番 TEE boundary 内に隔離します。秘密鍵を EC2 host、Lambda、relayer、GitHub Actions、Sui wallet config へ出してはいけません。
- Watcher と relayer の入力は contract boundary では untrusted として扱います。
- Source fetch、source hash / blob id 計算、BCS serialization、Merkle generation、signing の失敗は fail-closed にします。

## 今後の作業

- JMA など他の公開地震 feed を明示的に versioned source policy として追加する。
- 新しい ShakeMap format は fixture と golden vector を追加してから対応する。
- 単一 region MVP が安定した後に multi-region runner fallback を追加する。
- pending、rejected、failed、finalized state の運用 dashboard を追加する。
- 検証器ファミリー間で重複が見えた時点で runner / relayer utility の共通化を検討する。
