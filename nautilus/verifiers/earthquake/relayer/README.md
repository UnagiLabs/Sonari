# Earthquake Relayer

Delivers the signed finalized Oracle payload produced by the TEE core to the Sui Move contracts. It supports `preview`, `dry_run`, and explicit `submit` modes and builds the Move call transaction.

- **Role**: Deliver finalized payloads to Sui (preview / dry-run / submit) without changing their meaning.
- **Trust boundary**: Relayer only transports the signed payload; it must not alter payload semantics.

## Where to Read More
- [../../../../docs/verifiers/earthquake_relayer.md](../../../../docs/verifiers/earthquake_relayer.md) — full design / spec
- [../../../../docs/verifiers/overview.md](../../../../docs/verifiers/overview.md) — verifier system overview

---

# Earthquake Relayer（日本語）

TEE core が生成した署名済み Oracle payload を Sui Move コントラクトへ配送します。`preview` / `dry_run` / 明示的 `submit` の各モードに対応し、Move call トランザクションを構築します。

- **役割**: finalized payload を Sui へ配送する（preview / dry-run / submit）。payload の意味は変えない。
- **信頼境界**: relayer は署名済み payload を運ぶだけで、payload semantics を変更してはいけない。

## 詳細資料
- [../../../../docs/verifiers/earthquake_relayer.md](../../../../docs/verifiers/earthquake_relayer.md) — 完全な設計 / 仕様
- [../../../../docs/verifiers/overview.md](../../../../docs/verifiers/overview.md) — verifier 全体概要
