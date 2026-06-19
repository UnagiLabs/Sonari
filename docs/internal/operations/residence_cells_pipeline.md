# Residence Cells データ

このディレクトリは、residence-cell allowlist のためのローカル生成ツールを管理します。
Nautilus verifier ランタイムの一部ではありません。

ここに置く Rust CLI は、`data/residence_cells` 専用の独立ツールです。
root の Rust workspace には参加せず、`nautilus` 配下の crate にも依存しません。

このツールは、pin 留めされた Natural Earth land GeoJSON から H3 解像度 7 の
land allowlist を生成します。生成された allowlist 本体はローカル/S3 のアーティファクトです。
コントラクトが参照する値は、その結果として得られる Merkle root と関連メタデータです。

## ソース

pin 留めされた MVP ソースは以下です:

```text
https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_land.geojson
```

期待される SHA-256:

```text
1ac90796408bc6ad6911d69448485d3c4dbf2190370080368a09976e1c9f7416
```

git の外、`.build/residence-cells/` 配下にダウンロードします:

```bash
mkdir -p .build/residence-cells
curl -L \
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_land.geojson \
  -o .build/residence-cells/ne_10m_land.geojson
```

## 生成と検証

生成は `h3o::ContainmentMode::Covers` の tiler を polygon 単位で並列実行し、
最後に `h3_index` を数値昇順で sort / dedup します。
比較用に `--strategy hierarchical` も残していますが、full Natural Earth 生成では
`--strategy tiler` が実用 default です。

基本の流れは以下です。

1. `generate` で、Natural Earth land GeoJSON から allowlist JSON を作る。
2. `root` で、作成済み allowlist の Merkle root を確認する。
3. `proof` で、特定の H3 index が allowlist に含まれることを示す proof を作る。
4. `verify-local` で、manifest・allowlist・元ソースの整合性をローカル検証する。
5. `proof-shards` で、Worker が配布する proof shard を作る。
6. `verify-proof-shards` で、R2 から取得した proof shard artifact を検証する。

### 1. allowlist を生成する

`generate` は、pin 留めされた land GeoJSON を読み込み、H3 解像度 7 の
land cell を列挙して allowlist JSON に書き出します。通常はこのコマンドから始めます。
大きな入力を処理するため、必要に応じて `--jobs` で並列数を指定できます。

```bash
cargo run --release --manifest-path data/residence_cells/Cargo.toml -- generate \
  --source .build/residence-cells/ne_10m_land.geojson \
  --output .build/residence-cells/allowed_residence_cells.v1.res7.json \
  --allowlist-version 1 \
  --strategy tiler
```

### 2. Merkle root を確認する

`root` は、生成済み allowlist から Merkle root を計算します。
コントラクトや manifest が参照する代表値を確認したいときに使います。

```bash
cargo run --release --manifest-path data/residence_cells/Cargo.toml -- root \
  --allowlist .build/residence-cells/allowed_residence_cells.v1.res7.json \
  --source .build/residence-cells/ne_10m_land.geojson \
  --strategy tiler
```

### 3. 特定セルの proof を作る

`proof` は、指定した `--h3-index` が allowlist に含まれることを示す Merkle proof を
出力します。検証対象のセルを 1 件だけ確認したいときに使います。

```bash
cargo run --release --manifest-path data/residence_cells/Cargo.toml -- proof \
  --allowlist .build/residence-cells/allowed_residence_cells.v1.res7.json \
  --source .build/residence-cells/ne_10m_land.geojson \
  --h3-index 608819013513904127 \
  --strategy tiler
```

### 4. ローカルで全体の整合性を検証する

`verify-local` は、manifest、allowlist、元の Natural Earth GeoJSON を突き合わせます。
公開・アップロード前に、手元のアーティファクトが pin 留めされたソースから再現できることを
確認するための最終チェックです。

```bash
cargo run --release --manifest-path data/residence_cells/Cargo.toml -- verify-local \
  --manifest data/residence_cells/allowed_residence_cells_manifest.v1.res7.json \
  --allowlist .build/residence-cells/allowed_residence_cells.v1.res7.json \
  --source .build/residence-cells/ne_10m_land.geojson \
  --strategy tiler
```

`root`、`proof`、`verify-local` は、アーティファクトのメタデータだけを信頼しません。
root・proof・検証結果を出力する前に、pin 留めされたソースを読み直し、H3 インデックスを
再生成します。

### 5. proof shard を生成する

`proof-shards` は、allowlist 全件の Merkle proof を shard に分けて出力します。
CLI は R2 や AWS の認証情報を扱いません。ローカルの `.build/residence-cells/`
配下に `proof_manifest.json` と `shards/*.json.gz` を作るだけです。

```bash
cargo run --release --manifest-path data/residence_cells/Cargo.toml -- proof-shards \
  --allowlist .build/residence-cells/allowed_residence_cells.v1.res7.json \
  --source .build/residence-cells/ne_10m_land.geojson \
  --output-dir .build/residence-cells/proof-shards/v1/res7 \
  --shard-count 65536
```

manifest は shard inventory を持ちます。`total_proof_count` は allowlist の
H3 件数と一致する必要があります。`shards` 配列には `0..shard_count-1` の
全 shard を入れます。proof が 0 件の empty shards も `.json.gz` として出力し、
inventory に `proof_count: 0`、`sha256`、`byte_size` を記録します。

```json
{
  "schema": "sonari.residence.proof_manifest.v1",
  "schema_version": 1,
  "allowlist_version": 1,
  "geo_resolution": 7,
  "merkle_root": "0x...",
  "shard_count": 65536,
  "total_proof_count": 28175220,
  "object_key_rule": "residence-cells/v{allowlist_version}/res{geo_resolution}/proofs/shards/{shard_id:05}.json.gz",
  "shards": [
    {
      "shard_id": 0,
      "object_key": "residence-cells/v1/res7/proofs/shards/00000.json.gz",
      "proof_count": 430,
      "sha256": "0x...",
      "byte_size": 12345
    }
  ]
}
```

shard JSON は gzip 圧縮して `{shard_id:05}.json.gz` に保存します。
`object_key` は manifest の `object_key_rule` から決まり、R2 上でも同じ key に置きます。

```json
{
  "schema": "sonari.residence.proof_shard.v1",
  "schema_version": 1,
  "allowlist_version": 1,
  "geo_resolution": 7,
  "merkle_root": "0x...",
  "shard_id": 0,
  "shard_count": 65536,
  "proofs": [
    {
      "h3_index": "608819013513904127",
      "leaf_hash": "0x...",
      "proof": [
        {
          "sibling_on_left": true,
          "sibling_hash": "0x..."
        }
      ]
    }
  ]
}
```

### 6. R2 にアップロードする

R2 は proof shard の配布 surface です。secret は repo に保存しません。
運用端末や CI の secret store から次の環境変数を渡します。

```bash
export SONARI_R2_BUCKET="sonari-residence-cells"
export CLOUDFLARE_ACCOUNT_ID="..."
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."
```

AWS CLI の S3-compatible API で、manifest と shards を同じ prefix に同期します。
local output directory の `shards/{shard_id:05}.json.gz` は、manifest の
`object_key_rule` と同じ R2 object key になります。

```bash
aws s3 sync \
  .build/residence-cells/proof-shards/v1/res7/ \
  "s3://${SONARI_R2_BUCKET}/residence-cells/v1/res7/proofs/" \
  --endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
```

Earthquake TEE が使う residence tile manifest / tile shards も public R2 surface に置きます。
TEE/EC2 runtime には Cloudflare credential を渡さず、public HTTPS URL、object key、manifest SHA-256、allowlist metadata だけを GitHub Actions Variables / CloudFormation Parameters に登録します。

public R2 base URL は Cloudflare dashboard だけでなく、運用端末の `wrangler` でも確認します。custom domain を使う場合は bucket の public bucket domain ではなく、実際に配信する custom domain を `SONARI_RESIDENCE_R2_BASE_URL` に登録します。

```bash
wrangler r2 bucket domain get "$SONARI_R2_BUCKET"
curl -fsS "${SONARI_RESIDENCE_R2_BASE_URL%/}/residence-cells/v1/res7/tiles/tile_manifest.json" \
  -o .build/residence-cells/r2-tile-manifest.json
```

`SONARI_RESIDENCE_TILE_MANIFEST_SHA256` は、ローカル生成物ではなく、R2 にアップロード済みの正確な `tile_manifest.json` bytes から計算します。アップロード前のファイルや pretty-print し直した JSON から計算してはいけません。

```bash
SONARI_RESIDENCE_TILE_MANIFEST_SHA256="$(
  sha256sum .build/residence-cells/r2-tile-manifest.json | awk '{print $1}'
)"
```

GitHub environment `aws-sonari-verifier-runner-dev` / repo Variables に共有する値は次のとおりです。credential material は含めません。

| variable | source |
| --- | --- |
| `SONARI_RESIDENCE_R2_BASE_URL` | `wrangler r2 bucket domain get` または Cloudflare dashboard で確認した public HTTPS base URL |
| `SONARI_RESIDENCE_TILE_MANIFEST_KEY` | R2 上の `tile_manifest.json` object key |
| `SONARI_RESIDENCE_TILE_MANIFEST_SHA256` | R2 から取得し直した manifest bytes の lowercase SHA-256 |
| `SONARI_RESIDENCE_R2_OBJECT_PREFIX` | manifest と tile shard の共通 object prefix |
| `SONARI_RESIDENCE_R2_BUCKET` | manifest metadata の bucket 名 |
| `SONARI_RESIDENCE_ALLOWLIST_VERSION` | contract bootstrap と manifest metadata の allowlist version |
| `SONARI_RESIDENCE_ROOT` | AllowedResidenceCellRegistry の Merkle root |
| `SONARI_RESIDENCE_SOURCE_HASH` | 任意。Natural Earth source hash / allowlist source hash を evidence に残す場合だけ設定 |
| `SONARI_GEO_RESOLUTION` | `7` |

### 7. R2 artifact を検証する

R2 verification は、R2 から temp/build directory へ artifact を取得し直してから
`verify-proof-shards` を実行します。手元で生成したファイルを直接検証するだけでは、
アップロード漏れや object key のずれを検出できません。

```bash
rm -rf .build/residence-cells/r2-proof-shards/v1/res7
mkdir -p .build/residence-cells/r2-proof-shards/v1/res7
aws s3 sync \
  "s3://${SONARI_R2_BUCKET}/residence-cells/v1/res7/proofs/" \
  .build/residence-cells/r2-proof-shards/v1/res7/ \
  --endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
cargo run --release --manifest-path data/residence_cells/Cargo.toml -- verify-proof-shards \
  --manifest .build/residence-cells/r2-proof-shards/v1/res7/proof_manifest.json \
  --shards-dir .build/residence-cells/r2-proof-shards/v1/res7/shards
```

`verify-proof-shards` は manifest の inventory と実ファイルを照合します。
全 shard の `.json.gz` が存在すること、sha256、byte_size、proof count、
`total_proof_count`、shard id、Merkle root までの proof replay を検証します。

### 8. 旧 S3 proof/tree artifact を削除する

S3 cleanup は、R2 verification が成功した後にだけ行います。
最初は必ず `--dryrun` で old S3 proof/tree artifacts の対象を確認します。

```bash
aws s3 rm \
  "s3://${SONARI_RESIDENCE_CELLS_BUCKET}/residence-cells/v1/res7/proofs/" \
  --recursive \
  --dryrun
aws s3 rm \
  "s3://${SONARI_RESIDENCE_CELLS_BUCKET}/residence-cells/v1/res7/tree/" \
  --recursive \
  --dryrun
```

dryrun の対象が意図通りで、R2 から download した artifact の
`verify-proof-shards` が成功していることを確認してから、`--dryrun` を外します。
allowlist 本体など、proof/tree 以外の S3 artifact はこの手順では削除しません。

## 地図表示用 tile

地図の居住セル分類は、本来は発行直前用の重い proof API（`GET /api/residence-proof`）を
セル 1 個ずつ呼んでいました。pan/zoom のたびに数十〜数百の request が出ます。
これを「地図表示用の軽い static tile」配信に置き換えます。
proof API は MembershipPass 発行直前の 1 回だけに限定します。

tile は proof shard と同じ allowlist から作るので、両者のデータが食い違いません。
tile の単位は res7 セルの「res4 親セル」ごとに 1 個です。res4 は res7 を最大 343 個含みます。
許可セルが 0 個の親には tile を作りません。配信側の 404 を「all water（すべて陸地でない）」と
読みます。

### 9. tile を生成する

`tiles` は、allowlist 全件を res4 親セルごとに分配し、map display 用の tile JSON と
`tile_manifest.json` を出力します。CLI は R2 や AWS 認証情報を扱いません。

```bash
cargo run --release --manifest-path data/residence_cells/Cargo.toml -- tiles \
  --allowlist .build/residence-cells/allowed_residence_cells.v1.res7.json \
  --source .build/residence-cells/ne_10m_land.geojson \
  --output-dir .build/residence-cells/tiles/v1/res7
```

manifest は tile inventory を持ちます。`total_cell_count` は allowlist の
H3 件数と一致します。`tiles` 配列は親セルの `parent_h3_index` 昇順で並びます。

```json
{
  "schema": "sonari.residence.tile_manifest.v1",
  "schema_version": 1,
  "allowlist_version": 1,
  "geo_resolution": 7,
  "tile_parent_resolution": 4,
  "merkle_root": "0x...",
  "object_key_rule": "residence-cells/v{allowlist_version}/res{geo_resolution}/tiles/res4/{parent_hex}.json",
  "tile_count": 81234,
  "total_cell_count": 28175220,
  "tiles": [
    {
      "parent_h3_index": "842f5abffffffff",
      "object_key": "residence-cells/v1/res7/tiles/res4/842f5abffffffff.json",
      "cell_count": 343,
      "sha256": "0x...",
      "byte_size": 12345
    }
  ]
}
```

tile 本体は、その親に属する許可 res7 セルの昇順リストです。
`object_key` は manifest の `object_key_rule` から決まり、R2 上でも同じ key に置きます。
proof shard と違い tile は gzip 圧縮しません（version 入り path で immutable cache されるため）。

```json
{
  "schema": "sonari.residence.tile.v1",
  "schema_version": 1,
  "allowlist_version": 1,
  "geo_resolution": 7,
  "tile_parent_resolution": 4,
  "merkle_root": "0x...",
  "parent_h3_index": "842f5abffffffff",
  "cells": [
    "608819013513904127",
    "608819013597790207"
  ]
}
```

### 10. tile と proof の整合を検証する

`verify-tiles` は、tile manifest・tiles ディレクトリ・proof manifest をローカルで突き合わせます。
R2 に依存しないので CI でも実行できます。tile の全セル和集合と総数が proof と一致すること、
tile manifest の `merkle_root` が proof manifest と一致することを確認します。

```bash
cargo run --release --manifest-path data/residence_cells/Cargo.toml -- verify-tiles \
  --tile-manifest .build/residence-cells/tiles/v1/res7/tile_manifest.json \
  --tiles-dir .build/residence-cells/tiles/v1/res7/res4 \
  --proof-manifest .build/residence-cells/proof-shards/v1/res7/proof_manifest.json
```

`verify-tiles` は各 tile の `object_key`・`sha256`・`byte_size`・セル昇順・親一致を照合します。
tile のセル欠落・余剰、root 不一致、sha256 改ざんを検出すると FAIL します。

### 11. tile を R2 にアップロードする

proof shard と同じ R2 bucket に、別 prefix で同期します。
secret は repo に保存せず、運用端末や CI の secret store から渡します。

```bash
aws s3 sync \
  .build/residence-cells/tiles/v1/res7/ \
  "s3://${SONARI_R2_BUCKET}/residence-cells/v1/res7/tiles/" \
  --endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
```

tile の object key は `residence-cells/v{allowlist_version}/res{geo_resolution}/tiles/res4/{parent_hex}.json`
です。version 入り path なので、Worker は tile を
`Cache-Control: public, max-age=31536000, immutable` で配信します。
Cloudflare の edge cache が吸収するため、同じ Worker でも proof 発行への負荷流入は実質ゼロです。

## 運用前提

- R2 Standard storage を使います。
- Worker serving path reads R2。
- no per-proof DynamoDB/KV writes。
- Worker does not read S3 on serving path。
- R2 Infrequent Access は not for MVP serving path。
- R2/Worker are distribution surfaces。
- Move contract verifies proof/root。

## Worker serving path

`packages/residence-proof-worker` は、R2 に置いた proof shard から
対象セルの proof だけを返します。

API は次の形です。

```text
GET /api/residence-proof?h3_index=608819013681676287
```

Worker の R2 binding は `RESIDENCE_PROOF_SHARDS` です。
`ALLOWLIST_VERSION` と `GEO_RESOLUTION` は `wrangler.toml` vars を
source of truth とします。これらの値が R2 の `proof_manifest.json` と
一致しない場合、Worker は fail-closed で error を返します。

manifest key は次です。

```text
residence-cells/v{allowlist_version}/res{geo_resolution}/proofs/proof_manifest.json
```

shard key は manifest inventory の `object_key` を使います。
Worker は R2 object の `sha256`、`byte_size`、shard metadata、proof count を
manifest と照合します。さらに `leaf_hash` を再計算し、Merkle proof が
manifest の `merkle_root` まで replay できることを確認してから返します。

無料枠前提では、manifest cache を Worker isolate 内で使います。
1 request につき R2 shard read は原則 1 回です。
per-proof KV writes、per-proof DynamoDB writes、serving path の S3 read は行いません。

## S3 アーティファクト

allowlist 本体の全量を git にコミットしてはいけません。gzip 圧縮した
アーティファクトを `SONARI_RESIDENCE_CELLS_BUCKET` で指定されたバケットに
アップロードします:

```bash
gzip -c .build/residence-cells/allowed_residence_cells.v1.res7.json \
  > .build/residence-cells/allowed_residence_cells.v1.res7.json.gz
aws s3 cp \
  .build/residence-cells/allowed_residence_cells.v1.res7.json.gz \
  "s3://${SONARI_RESIDENCE_CELLS_BUCKET}/residence-cells/v1/res7/allowed_residence_cells.v1.res7.json.gz"
```

アップロード後、`allowed_residence_cells_manifest.v1.res7.json` を、アーティファクトの
SHA-256、バイトサイズ、H3 カウント、Merkle root、生成タイムスタンプ、および
バケットでバージョニングが有効な場合は S3 バージョン ID で更新します。
