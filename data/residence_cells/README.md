# Residence Cells

Local generation tooling for the residence-cell allowlist: produces the H3 res7 land allowlist, Merkle root, proof shards, and map tiles from pinned Natural Earth GeoJSON.

- **Role**: Residence-cell generation pipeline (allowlist, proofs, tiles).

## Operational Surface

- Proof shard commands: `proof-shards` and `verify-proof-shards`.
- Proof manifest: `proof_manifest.json`.
- Proof inventory fields: `total_proof_count`, `inventory`, `sha256`, and `byte_size`.
- Proof shard files include empty shards and use `.json.gz`.
- Proof shard key rule: `residence-cells/v{allowlist_version}/res{geo_resolution}/proofs/shards/{shard_id:05}.json.gz`.
- R2 upload inputs: `SONARI_R2_BUCKET`, `CLOUDFLARE_ACCOUNT_ID`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY`.
- R2 upload uses `aws s3 sync` with `--endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"`.
- R2 verification uses `verify-proof-shards` after downloading artifacts back from R2.
- Old S3 proof/tree artifacts are removed only after R2 verification, with `aws s3 rm --recursive --dryrun` first.
- Serving assumptions: R2 Standard storage, Worker serving path reads R2, no per-proof DynamoDB/KV writes, Worker does not read S3 on serving path, R2 Infrequent Access is not for MVP serving path, R2/Worker are distribution surfaces, and Move contract verifies proof/root.
- Worker API: `GET /api/residence-proof?h3_index=608819013681676287`.
- Worker binding and vars: `RESIDENCE_PROOF_SHARDS`, `ALLOWLIST_VERSION`, and `GEO_RESOLUTION`.
- Proof manifest key: `residence-cells/v{allowlist_version}/res{geo_resolution}/proofs/proof_manifest.json`.
- Worker uses manifest cache and checks `sha256` and `byte_size`.
- Serving path avoids per-proof KV writes and per-proof DynamoDB writes.
- Tile schemas: `sonari.residence.tile.v1` and `sonari.residence.tile_manifest.v1`.
- Tile manifest: `tile_manifest.json`, `tile_parent_resolution`, `parent_h3_index`, and `total_cell_count`.
- Tile key rule: `residence-cells/v{allowlist_version}/res{geo_resolution}/tiles/res4/{parent_hex}.json`.
- Tile commands: `tiles` and `verify-tiles` with `--tiles-dir`, `--tile-manifest`, and `--proof-manifest`.
- Tile serving uses `Cache-Control: public, max-age=31536000, immutable`.
- Missing tile parent returns `404` and means `all water` for map display.

## Where to Read More
- [../../docs/internal/operations/residence_cells_pipeline.md](../../docs/internal/operations/residence_cells_pipeline.md) — full runbook / setup
- [../../docs/internal/operations/README.md](../../docs/internal/operations/README.md) — operations index

---

# Residence Cells（日本語）

residence-cell allowlist のローカル生成ツールです。pin 留めした Natural Earth GeoJSON から H3 res7 の land allowlist、Merkle root、proof shard、map tile を生成します。

- **役割**: residence-cell 生成パイプライン（allowlist、proof、tile）。

## 運用上の公開面

- proof shard コマンドは `proof-shards` と `verify-proof-shards` です。
- proof manifest は `proof_manifest.json` です。
- proof inventory は `total_proof_count`、`inventory`、`sha256`、`byte_size` を持ちます。
- proof shard は empty shards も含め、`.json.gz` で保存します。
- proof shard key rule は `residence-cells/v{allowlist_version}/res{geo_resolution}/proofs/shards/{shard_id:05}.json.gz` です。
- R2 upload には `SONARI_R2_BUCKET`、`CLOUDFLARE_ACCOUNT_ID`、`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY` を使います。
- R2 upload は `aws s3 sync` と `--endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"` を使います。
- R2 verification は、R2 から再取得した artifact に `verify-proof-shards` を実行します。
- old S3 proof/tree artifacts は、R2 verification 後に `aws s3 rm --recursive --dryrun` で対象を確認してから削除します。
- 配信前提は R2 Standard storage、Worker serving path reads R2、no per-proof DynamoDB/KV writes、Worker does not read S3 on serving path、R2 Infrequent Access は not for MVP serving path、R2/Worker are distribution surfaces、Move contract verifies proof/root です。
- Worker API は `GET /api/residence-proof?h3_index=608819013681676287` です。
- Worker binding と vars は `RESIDENCE_PROOF_SHARDS`、`ALLOWLIST_VERSION`、`GEO_RESOLUTION` です。
- proof manifest key は `residence-cells/v{allowlist_version}/res{geo_resolution}/proofs/proof_manifest.json` です。
- Worker は manifest cache を使い、`sha256` と `byte_size` を検証します。
- serving path は per-proof KV writes と per-proof DynamoDB writes を避けます。
- tile schemas は `sonari.residence.tile.v1` と `sonari.residence.tile_manifest.v1` です。
- tile manifest は `tile_manifest.json`、`tile_parent_resolution`、`parent_h3_index`、`total_cell_count` を持ちます。
- tile key rule は `residence-cells/v{allowlist_version}/res{geo_resolution}/tiles/res4/{parent_hex}.json` です。
- tile コマンドは `tiles` と `verify-tiles` で、`--tiles-dir`、`--tile-manifest`、`--proof-manifest` を使います。
- tile 配信は `Cache-Control: public, max-age=31536000, immutable` を使います。
- tile がない parent は `404` を返し、map display では `all water` と扱います。

## 詳細資料
- [../../docs/internal/operations/residence_cells_pipeline.md](../../docs/internal/operations/residence_cells_pipeline.md) — 完全な runbook / セットアップ
- [../../docs/internal/operations/README.md](../../docs/internal/operations/README.md) — 運用インデックス
