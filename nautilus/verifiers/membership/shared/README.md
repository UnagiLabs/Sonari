# Membership Shared

`membership/shared` は、Membership verifier の TypeScript 側 contract package です。

TEE、runner、Move contract-facing test が同じ identity result layout を参照できるように、field order、provider enum、hash rule、validation helper をここに集約します。

## 何を担当するか

- `IdentityVerificationResult` の TypeScript 型。
- identity result の BCS hex encode。
- contract-facing field order の固定。
- KYC / World ID provider enum の固定。
- duplicate key hash の計算。
- World ID nullifier の正規化。
- Membership identity state の変換 helper。

## 重要な不変条件

`IDENTITY_RESULT_FIELD_ORDER` と `IDENTITY_PROVIDER_BCS` は Move / Rust / TypeScript をまたぐ契約です。変更する場合は、新しい version を定義するか、互換性への影響を明示したうえで Rust test、TypeScript test、Move test、fixture を更新します。

`duplicate_key_hash` は provider 内の重複登録を防ぐ値です。KYC と World ID で計算 rule が異なるため、caller 側で ad hoc に組み立てず、この package の helper を使います。

World ID の duplicate key は `sonari:world_id:v2`、`rp_id`、`action`、正規化済み `nullifier` から計算します。旧 `world_app_id` 名や `sonari:world_id:v1` は使いません。

## 検証

```bash
pnpm --filter @sonari/membership-verifier-shared test
pnpm --filter @sonari/membership-verifier-shared typecheck
```
