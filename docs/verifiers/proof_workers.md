# Proof Workers

## Affected-cells proof worker

このパッケージは、地震影響セル（affected cells）の Merkle proof を管理する Cloudflare Worker です。

### 役割

- **登録（POST）**: AWS から affected cells データの Walrus URI を受け取り、hash/root/schema を検証した上で Merkle proof を生成して Cloudflare R2 に保存する。
- **配信（GET）**: フロントエンドから h3_index を受け取り、R2 に保存済みの proof を返す。返す前に leaf_hash 独立再計算と proof replay で完全性を検証する（fail-closed）。

このパッケージは `@sonari/proof-core` に依存し、proof 生成・検証のロジックはすべて proof-core の公開 API を使っています。proof の生成・検証ロジックをここで再実装することはありません。

### API

#### 登録（AWS → Worker）

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

#### 配信（フロントエンド → Worker）

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

### エラーコード一覧

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

### R2 key 形式

```
affected-proofs/events/<event_uid>/revisions/<event_revision>/manifest.json
affected-proofs/events/<event_uid>/revisions/<event_revision>/shards/<shard_id>.json
```

MVP では `shard_count = 1` で固定です。

### ローカル検証

```bash
# ユニットテスト
pnpm --filter @sonari/affected-cells-proof-worker test

# 型検査
pnpm --filter @sonari/affected-cells-proof-worker typecheck

# モノレポ全体の型検査
pnpm check:ts
```

### デプロイ手順

実際の deploy には Cloudflare アカウントと認証が必要です。

#### 1. R2 bucket を作成する

```bash
wrangler r2 bucket create sonari-affected-proofs-v1
```

#### 2. Secret を登録する

secret は絶対に repo にコミットしないこと。以下のコマンドで Cloudflare に登録します。

```bash
# AWS からの登録トークン
wrangler secret put AFFECTED_PROOF_REGISTER_TOKEN

# Walrus aggregator URL（プライベートの場合）
# wrangler secret put WALRUS_AGGREGATOR_URL
```

#### 3. デプロイ（初回・手動）

初回セットアップやフォールバック用途では、手動で deploy します。

```bash
wrangler deploy
```

#### 4. 自動デプロイ（GitHub Actions）

通常の更新は手動 deploy 不要です。GitHub Actions が自動で deploy します。

- **自動トリガ**: 次の path の変更が `main` に入ると、自動で `wrangler deploy` が走ります。
  - `packages/affected-cells-proof-worker/**`（worker 本体）
  - `packages/proof-core/**`（worker が依存する proof ロジック。ここの変更でも再デプロイされる）
  - `pnpm-lock.yaml`（依存解決の変更を反映する）
- **手動トリガ**: GitHub Actions の画面から `workflow_dispatch`（手動実行）でも deploy できます。
- workflow 定義は `.github/workflows/affected-cells-proof-worker-deploy.yml` です。

自動デプロイで CI に渡すのは **Cloudflare API token のみ** です。GitHub の environment
`cloudflare-affected-cells-proof-worker` に `CLOUDFLARE_API_TOKEN`（必要なら
`CLOUDFLARE_ACCOUNT_ID`）を secret として登録します。

`AFFECTED_PROOF_REGISTER_TOKEN` などのアプリ secret は CI に渡しません。これらは従来どおり
上記「2. Secret を登録する」の `wrangler secret put` で Cloudflare 側に別管理します。

### セキュリティ注意事項

- `AFFECTED_PROOF_REGISTER_TOKEN` は絶対に repo にコミットしないこと
- `wrangler.toml` の `[vars]` セクションは public な設定値のみ記載する
- secret 値が漏洩した場合は直ちに `wrangler secret put` でローテーションすること

---

## Residence proof worker

この package は、居住セル allowlist の Merkle proof を R2 から取り出す
Cloudflare Worker です。フロントエンドは
`GET /api/residence-proof?h3_index=...` を呼び、返された `home_cell + proof`
を Sui transaction に入れます。

Worker と R2 は配布 surface です。最終的な正しさは Move contract が
登録済み Merkle root と proof で検証します。

### API

```text
GET /api/residence-proof?h3_index=608819013681676287
```

成功時は対象セルの proof だけを返します。shard 全体は返しません。

```json
{
  "h3_index": "608819013681676287",
  "allowlist_version": 1,
  "geo_resolution": 7,
  "merkle_root": "0xa26a12dc49754fde5b90e6bff69d1bc8b51fb8a3de07aa9122a9a2958bb75020",
  "proof": [
    {
      "sibling_on_left": true,
      "sibling_hash": "0x312e3863ccf00e446423342e1acebdab8e7119ee19dae854904de693225c2678"
    }
  ]
}
```

`proof` は Move の `allowed_residence_cell::ProofStep` に変換しやすいように、
`[{ sibling_on_left, sibling_hash }]` の形を保ちます。

失敗時は次の形を返します。

```json
{
  "error": {
    "code": "invalid_h3_index",
    "message": "h3_index is required"
  }
}
```

主な error code は次です。

- `invalid_h3_index`
- `residence_cell_not_allowed`
- `proof_manifest_missing`
- `proof_manifest_invalid`
- `proof_shard_missing`
- `proof_shard_integrity_mismatch`
- `proof_shard_invalid`
- `proof_invalid`
- `method_not_allowed`
- `not_found`

### 地図表示用 tile API

地図の land/water 表示は、重い `/api/residence-proof` をセルごとに呼ぶ代わりに、
軽い static tile を読みます。proof API は MembershipPass 発行直前の 1 回だけに限定します。
tile は proof shard と同じ R2 binding `RESIDENCE_PROOF_SHARDS` から読みます。新 binding は不要です。

#### meta

```text
GET /api/residence-tiles/meta
```

設定中の version / resolution / merkle_root を返します。inventory（tile 一覧）は返しません。
`Cache-Control: public, max-age=300` を付けます。

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
  "total_cell_count": 28175220
}
```

#### tile

```text
GET /api/residence-tiles/v{allowlist_version}/res{geo_resolution}/{parent_hex}.json
```

`parent_hex` は res7 セルの res4 親セルの小文字 hex です。成功時はその親に属する
許可 res7 セルの昇順リストを返し、`Cache-Control: public, max-age=31536000, immutable`
を付けます。version 入り URL なので Cloudflare の edge cache（`caches.default`）が吸収します。

許可セルが 0 個の親（R2 に tile が無い）は `404 tile_not_found` を返します。
dapp はこれを「all water（すべて陸地でない）」と読みます。
path の version が Worker 設定と不一致なら `409 tile_version_mismatch` で fail-closed します。

tile の error code は次です。

- `tile_not_found`
- `tile_version_mismatch`
- `tile_invalid`
- `tile_manifest_missing`
- `tile_manifest_invalid`

### R2 binding と vars

Worker は `wrangler.toml` の値を source of truth とします。
未設定や manifest との不一致は fail-closed です。

```toml
[[r2_buckets]]
binding = "RESIDENCE_PROOF_SHARDS"
bucket_name = "sonari-residence-proofs-v1-res7"

[vars]
ALLOWLIST_VERSION = "1"
GEO_RESOLUTION = "7"
```

secret、account id、access key は repo に保存しません。

### R2 object key

manifest key は version と resolution から決まります。

```text
residence-cells/v{allowlist_version}/res{geo_resolution}/proofs/proof_manifest.json
```

shard key は manifest inventory の `object_key` を使います。
生成側の rule は次です。

```text
residence-cells/v{allowlist_version}/res{geo_resolution}/proofs/shards/{shard_id:05}.json.gz
```

tile の manifest と tile key は次です。

```text
residence-cells/v{allowlist_version}/res{geo_resolution}/tiles/tile_manifest.json
residence-cells/v{allowlist_version}/res{geo_resolution}/tiles/res4/{parent_hex}.json
```

Worker は shard を返す前に次を検証します。

- `h3_index` は canonical decimal string として読む。
- `h3_index` は H3 cell mode と `GEO_RESOLUTION` に一致する。
- shard id は `sha256(h3_index.to_be_bytes())` で決める。
- R2 object の `byte_size` は manifest と一致する。
- R2 object の `sha256` は manifest と一致する。
- shard metadata は manifest と一致する。
- `leaf_hash` は `h3_index`、`geo_resolution`、`allowlist_version` から再計算する。
- Merkle proof は manifest の `merkle_root` まで replay できる。

### 無料枠前提

MVP では request 数を限定します。serving path では R2 だけを読みます。

- 1 request につき R2 manifest read は cache miss 時だけです。
- 1 request につき R2 shard read は原則 1 回です。
- manifest は Worker isolate 内で cache します。
- per-proof KV writes はしません。
- per-proof DynamoDB writes はしません。
- Worker serving path で S3 は読みません。
- R2 Standard storage を使います。
- R2 Infrequent Access は MVP serving path では使いません。

`ALLOWLIST_VERSION` を変えると manifest key と cache key も変わります。
新しい version の R2 artifact を検証してから Worker vars を更新します。

### ローカル検証

```bash
pnpm --filter @sonari/residence-proof-worker test
pnpm --filter @sonari/residence-proof-worker typecheck
pnpm check:ts
```

### デプロイ手順

実際の deploy には Cloudflare アカウントと認証が必要です。

#### 1. R2 bucket を作成する

```bash
wrangler r2 bucket create sonari-residence-proofs-v1-res7
```

#### 2. Secret を登録する

現時点では runtime secret は未定義ですが、将来追加する場合は `wrangler secret put` で
Cloudflare に登録します。絶対に repo にコミットしないこと。

#### 3. デプロイ（初回・手動）

初回セットアップやフォールバック用途として、手動で deploy します。

```bash
wrangler deploy
```

#### 4. 自動デプロイ（GitHub Actions）

通常の更新は手動 deploy 不要です。GitHub Actions が自動で deploy します。

- **自動トリガ**: 次の path の変更が `main` に入ると、自動で `wrangler deploy` が走ります。
  - `packages/residence-proof-worker/**`（worker 本体）
  - `packages/proof-core/**`（worker が依存する proof ロジック。ここの変更でも再デプロイされる）
  - `pnpm-lock.yaml`（依存解決の変更を反映する）
  - `.github/workflows/residence-proof-worker-deploy.yml`（ワークフロー変更）
- **手動トリガ**: GitHub Actions の画面から `workflow_dispatch`（手動実行）でも deploy できます。
- workflow 定義は `.github/workflows/residence-proof-worker-deploy.yml` です。

自動デプロイで CI に渡すのは **Cloudflare API token のみ** です。Cloudflare 認証情報は
GitHub の共通 environment `cloudflare-affected-cells-proof-worker` に
`CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を secret として登録します。

workflow は deploy 成功後に `cloudflare-residence-proof-worker` の deployment history を更新します。
そのため、residence worker 専用 environment に Cloudflare secret を重複登録する必要はありません。

`AFFECTED_PROOF_REGISTER_TOKEN` のようなアプリ secret は CI には渡しません。必要なら
上記「2. Secret を登録する」の `wrangler secret put` で Cloudflare 側に別管理します。
