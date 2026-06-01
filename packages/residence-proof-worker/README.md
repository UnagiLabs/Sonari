# Residence Proof Worker

この package は、居住セル allowlist の Merkle proof を R2 から取り出す
Cloudflare Worker です。フロントエンドは
`GET /api/residence-proof?h3_index=...` を呼び、返された `home_cell + proof`
を Sui transaction に入れます。

Worker と R2 は配布 surface です。最終的な正しさは Move contract が
登録済み Merkle root と proof で検証します。

## API

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

## R2 binding と vars

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

## R2 object key

manifest key は version と resolution から決まります。

```text
residence-cells/v{allowlist_version}/res{geo_resolution}/proofs/proof_manifest.json
```

shard key は manifest inventory の `object_key` を使います。
生成側の rule は次です。

```text
residence-cells/v{allowlist_version}/res{geo_resolution}/proofs/shards/{shard_id:05}.json.gz
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

## 無料枠前提

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

## ローカル検証

```bash
pnpm --filter @sonari/residence-proof-worker test
pnpm --filter @sonari/residence-proof-worker typecheck
pnpm check:ts
```
