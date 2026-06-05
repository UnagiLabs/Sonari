# affected-cells-proof-worker

このパッケージは、地震影響セル（affected cells）の Merkle proof を管理する Cloudflare Worker です。

## 役割

- **登録（POST）**: AWS から affected cells データの Walrus URI を受け取り、hash/root/schema を検証した上で Merkle proof を生成して Cloudflare R2 に保存する。
- **配信（GET）**: フロントエンドから h3_index を受け取り、R2 に保存済みの proof を返す。返す前に leaf_hash 独立再計算と proof replay で完全性を検証する（fail-closed）。

このパッケージは `@sonari/proof-core` に依存し、proof 生成・検証のロジックはすべて proof-core の公開 API を使っています。proof の生成・検証ロジックをここで再実装することはありません。

## API

### 登録（AWS → Worker）

```
POST /events/:event_uid/revisions/:event_revision/affected-cells
```

**リクエストヘッダ:**
- `x-sonari-affected-proof-register-token: <secret>` — secret は deploy 時に `wrangler secret put AFFECTED_PROOF_REGISTER_TOKEN` で設定

**リクエストボディ（JSON）:**
```json
{
  "event_uid": "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd",
  "event_revision": 1,
  "affected_cells_hash": "0xc3bb6d3a...",
  "affected_cells_root": "0x526e9824...",
  "affected_cell_count": 2,
  "geo_resolution": 7,
  "affected_cells_uri": "walrus://blob/<blob-id>"
}
```

**レスポンス（200 OK）:**
```json
{
  "event_uid": "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd",
  "event_revision": 1,
  "affected_cells_root": "0x526e9824...",
  "shard_count": 1,
  "stored": true
}
```

同じ `event_uid`/`event_revision`/`root` で再登録すると `stored: false` の 200 no-op を返します（冪等）。
root が異なる再登録は fail-closed で拒否されます。

### 配信（フロントエンド → Worker）

```
GET /events/:event_uid/revisions/:event_revision/proof?h3_index=<decimal>
```

**レスポンス（200 OK）:**
```json
{
  "event_uid": "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd",
  "event_revision": 1,
  "h3_index": "608819013513904127",
  "affected_cells_root": "0x526e9824...",
  "leaf": {
    "event_uid": "0xab131dd...",
    "event_revision": 1,
    "h3_index": "608819013513904127",
    "geo_resolution": 7,
    "cell_band": 3,
    "intensity_value": 831,
    "cell_metric": "USGS_MMI",
    "intensity_scale": "MMI_X100",
    "cells_generation_method": "shakemap_gridxml_h3_grid_point_p90_v1",
    "oracle_version": "1"
  },
  "proof": [
    {
      "sibling_on_left": true,
      "sibling_hash": "0x..."
    }
  ]
}
```

## エラーコード一覧

| code | HTTP | 説明 |
|------|------|------|
| `invalid_request` | 400 | リクエスト形式不正（h3_index, URI, 必須フィールド欠落など） |
| `unauthorized` | 401 | 登録 token が不正または欠落 |
| `affected_cells_hash_mismatch` | 400 | Walrus データの SHA-256 が body の hash と不一致 |
| `affected_cells_root_mismatch` | 400/409 | Merkle root が body と不一致、または既存登録との衝突 |
| `affected_cells_invalid` | 400 | affected cells ファイルの schema 違反 |
| `walrus_fetch_failed` | 502 | Walrus aggregator からのデータ取得失敗 |
| `affected_cell_not_in_event` | 404 | 指定した h3_index はこの event に含まれない |
| `proof_manifest_missing` | 404 | R2 に manifest が存在しない（未登録） |
| `proof_manifest_invalid` | 500 | manifest の形式が不正 |
| `proof_shard_missing` | 500 | R2 に shard が存在しない |
| `proof_shard_integrity_mismatch` | 500 | shard の SHA-256 が manifest と不一致 |
| `proof_shard_invalid` | 500 | shard の形式不正、または leaf_hash/proof replay 不一致 |
| `method_not_allowed` | 405 | 許可されていない HTTP メソッド |
| `not_found` | 404 | ルートが存在しない |
| `internal` | 500 | 内部エラー |

## R2 key 形式

```
affected-proofs/events/<event_uid>/revisions/<event_revision>/manifest.json
affected-proofs/events/<event_uid>/revisions/<event_revision>/shards/<shard_id>.json
```

MVP では `shard_count = 1` で固定です。

## ローカル検証

```bash
# ユニットテスト
pnpm --filter @sonari/affected-cells-proof-worker test

# 型検査
pnpm --filter @sonari/affected-cells-proof-worker typecheck

# モノレポ全体の型検査
pnpm check:ts
```

## デプロイ手順

実際の deploy には Cloudflare アカウントと認証が必要です。

### 1. R2 bucket を作成する

```bash
wrangler r2 bucket create sonari-affected-proofs-v1
```

### 2. Secret を登録する

secret は絶対に repo にコミットしないこと。以下のコマンドで Cloudflare に登録します。

```bash
# AWS からの登録トークン
wrangler secret put AFFECTED_PROOF_REGISTER_TOKEN

# Walrus aggregator URL（プライベートの場合）
# wrangler secret put WALRUS_AGGREGATOR_URL
```

### 3. デプロイ

```bash
wrangler deploy
```

## セキュリティ注意事項

- `AFFECTED_PROOF_REGISTER_TOKEN` は絶対に repo にコミットしないこと
- `wrangler.toml` の `[vars]` セクションは public な設定値のみ記載する
- secret 値が漏洩した場合は直ちに `wrangler secret put` でローテーションすること
