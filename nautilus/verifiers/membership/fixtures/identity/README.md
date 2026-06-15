# Identity Fixtures

`identity` は、Membership SBT の本人確認 result を表す JSON fixture を置く場所です。

現在の provider は KYC と World ID です。fixture は success / reject の最小パターンを固定し、TypeScript と Rust の BCS encode、duplicate key hash、evidence hash の互換性確認に使います。

## ファイル

| ファイル | 意味 |
| --- | --- |
| `kyc_success.json` | KYC provider が verified result を返したケース |
| `kyc_reject.json` | KYC provider が reject されたケース |
| `world_id_success.json` | World ID proof が verified result を返したケース |
| `world_id_reject.json` | World ID proof が reject されたケース |

## 注意点

- raw PII、実ユーザーの proof、実 provider credential は置かない。
- `intent`、`verifier_family`、`verifier_version`、provider enum、hash fields は contract-facing な値として扱う。
- `verified: true` の result だけが署名済み payload の対象になる。
- reject fixture は rejection rule の確認用であり、on-chain 提出用 payload ではない。

---

**Parent docs**: [../../../../../docs/verifiers/identity.md](../../../../../docs/verifiers/identity.md) — component overview & full spec.
**親資料**: 同上（上位コンポーネントの概要・完全仕様）。
