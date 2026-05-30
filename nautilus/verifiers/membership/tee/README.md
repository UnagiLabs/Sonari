# Membership TEE

Membership TEE は、Membership SBT の本人確認結果を作る Rust crate です。

TEE は外部の World ID API を確認し、結果を payload（受け渡すデータ本体）として組み立てます。確認済みの結果だけを BCS payload（Move に渡すための binary 形式）へ変換し、その bytes に署名します。

## 何を担当するか

この crate は、本人確認の TEE 側境界を担当します。

- stdin から本人確認 request を受け取る。
- World ID proof（本人確認に使う検証データ）を確認する。
- 成功時だけ contract 向け payload を作る。
- 成功時だけ payload BCS bytes に署名する。
- 拒否、外部サービス待ち、未対応の場合は署名を出さない。

Relayer や worker は、この crate が返した結果の意味を変えてはいけません。Move contract は、署名された payload だけを信頼します。

## CLI の入口

`membership-tee` には 3 つの入口があります。

| 入口 | 用途 | 署名 seed |
| --- | --- | --- |
| `fixture` | test や fixture 用の deterministic 実行 | dev fallback を許す |
| `production` | 実運用で World ID API を確認する | env または file が必須 |
| `--encode-only` | TS/Rust の BCS bytes 一致を確認する | 署名しない |

`fixture` と `production` は、stdin から `IdentityVerifyRequest` JSON を 1 つ読みます。stdout には status 付き JSON を 1 つだけ返します。
AWS interface では 1 request = 1 JSON in / 1 JSON out として固定します。
TEE は stateless です。前の job 状態は持ちません。

## 入力 request

request は次の field を受け取ります。

```text
registry_id
membership_id
owner
provider
issued_at_ms
validity_ms
terms_version
signed_statement_hash
world_id.world_app_id
world_id.nullifier_hash
world_id.merkle_root
world_id.proof
world_id.verification_level
world_id.action
world_id.signal_hash
```

未知の field は拒否します。top-level の field も、`world_id` の中の field も同じです。これは、raw PII や想定外の proof detail を TEE 境界に混ぜないためです。

## 出力 status

stdout の `status` は 4 種類です。

| status | 意味 | 署名 |
| --- | --- | --- |
| `verified` | 本人確認済み | あり |
| `rejected` | proof や信頼境界の確認に失敗 | なし |
| `pending_source` | World ID API など外部 source を確認できない | なし |
| `unsupported` | provider が未対応 | なし |

`verified` の場合だけ、次を返します。

```text
IdentityTeeResult fields
payload_bcs_hex
signature
public_key
```

`rejected`、`pending_source`、`unsupported` の場合は `error_code` だけを返します。payload、signature、public_key は返しません。
verified stdout は bare `IdentityTeeResult` ではありません。
`status: "verified"` と `IdentityTeeResult` fields に加えて、署名 fields を返します。
非 verified stdout は `status` と `error_code` だけを返します。
`pending_source` は earthquake と同じ再試行用の語です。

## 署名のルール

署名対象は payload BCS bytes そのものです。

Sui intent prefix は付けません。payload の field order や enum 値は、Move / Rust / TypeScript をまたぐ契約です。変更する場合は、schema、golden vector、Rust test、TypeScript test を一緒に更新してください。

## production の安全境界

`production` は signing seed を command line argument から受け取りません。

次のどちらかを使います。

```text
SONARI_TEE_SIGNING_KEY_SEED
SONARI_TEE_SIGNING_KEY_SEED_FILE
```

AWS 境界 interface として固定する env は次の 3 つです。

```text
SONARI_TEE_SIGNING_KEY_SEED
SONARI_TEE_SIGNING_KEY_SEED_FILE
SONARI_WORLD_ID_API_BASE
```

`SONARI_WORLD_ID_APP_ID` は production の runtime config として必須です。
ただし AWS 境界 interface の固定対象とは分けて扱います。
本番では KMS や Nitro attestation へ差し替える場合があります。
その場合も stdin/stdout の JSON 契約は変えないでください。

request 由来の `issued_at_ms` と `validity_ms` は production では信頼しません。TEE 側の現在時刻と既定 TTL を使います。これは、caller が長すぎる有効期限を持つ署名済み payload を作らせないためです。

## fixture の使い方

`fixture` は test 用です。`issued_at_ms` を request に入れると、同じ入力から同じ時刻の payload を作れます。

World ID の結果は flag で切り替えられます。

```bash
membership-tee fixture --world-id-status verified
membership-tee fixture --world-id-status rejected
membership-tee fixture --world-id-status pending-source
```

`provider` が `kyc` の場合は、現在は未対応として `unsupported` を返します。error code は `KYC_NOT_IMPLEMENTED` です。

## encode-only

`--encode-only` は、完成済みの `IdentityTeeResult` JSON を stdin から読みます。署名はせず、BCS hex だけを返します。

```json
{"payload_bcs_hex":"0x..."}
```

`verified` が `true` でない payload は拒否します。これは、reject payload を on-chain 提出用 bytes として扱わないためです。

## 失敗時の考え方

この crate は fail-closed を優先します。入力が壊れている、unknown field がある、seed がない、外部 source を確認できない、という場合は安全側に倒します。

特に、署名できるのは `verified` のみです。`rejected`、`pending_source`、`unsupported` に署名を付けてはいけません。
