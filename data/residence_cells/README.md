# Residence Cells データ

このディレクトリは、residence-cell allowlist のためのローカルデータツールを管理します。
Nautilus verifier ランタイムの一部ではありません。

このツールは、pin 留めされた Natural Earth land GeoJSON から H3 解像度 7 の
land allowlist を生成します。生成された allowlist 本体はローカル/S3 のアーティファクトです。
コントラクトが参照する値は、その結果として得られる Merkle root と関連メタデータです。

## セットアップ

リポジトリのルートから `uv` を使います:

```bash
uv sync --project data/residence_cells
```

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

```bash
uv run --project data/residence_cells residence-allowlist generate \
  --source .build/residence-cells/ne_10m_land.geojson \
  --output .build/residence-cells/allowed_residence_cells.v1.res7.json \
  --allowlist-version 1
```

```bash
uv run --project data/residence_cells residence-allowlist root \
  --allowlist .build/residence-cells/allowed_residence_cells.v1.res7.json \
  --source .build/residence-cells/ne_10m_land.geojson
```

```bash
uv run --project data/residence_cells residence-allowlist proof \
  --allowlist .build/residence-cells/allowed_residence_cells.v1.res7.json \
  --source .build/residence-cells/ne_10m_land.geojson \
  --h3-index 608819013513904127
```

```bash
uv run --project data/residence_cells residence-allowlist verify-local \
  --manifest data/residence_cells/allowed_residence_cells_manifest.v1.res7.json \
  --allowlist .build/residence-cells/allowed_residence_cells.v1.res7.json \
  --source .build/residence-cells/ne_10m_land.geojson
```

`root`、`proof`、`verify-local` は、アーティファクトのメタデータだけを信頼することはしません。
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
