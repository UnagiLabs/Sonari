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
