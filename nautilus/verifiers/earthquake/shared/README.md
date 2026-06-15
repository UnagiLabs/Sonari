# Earthquake Shared

The cross-language contract for the earthquake verifier: payload field order, Merkle leaf field order, BCS enum mappings, offchain statuses, error codes, validators, and shared types used by both the Rust TEE core and the TypeScript watcher / relayer.

- **Role**: Single source of truth for the shared rules (field order, enums, validators) that TEE / watcher / relayer must agree on.
- **Trust boundary**: Defines the signed-payload field order and BCS encoding contract; changes are a cross-language contract change.

## Where to Read More
- [../../../../docs/verifiers/earthquake_shared.md](../../../../docs/verifiers/earthquake_shared.md) — full design / spec
- [../../../../docs/verifiers/overview.md](../../../../docs/verifiers/overview.md) — verifier system overview

---

# Earthquake Shared（日本語）

地震検証器のクロス言語契約です。payload field order、Merkle leaf field order、BCS enum マッピング、offchain status、error code、validator、共有型を定義し、Rust TEE core と TypeScript watcher / relayer の両方が参照します。

- **役割**: TEE / watcher / relayer が一致させるべき共通ルール（field order、enum、validator）の単一情報源。
- **信頼境界**: 署名対象 payload の field order と BCS encoding 契約を定義する。変更はクロス言語契約の変更となる。

## 詳細資料
- [../../../../docs/verifiers/earthquake_shared.md](../../../../docs/verifiers/earthquake_shared.md) — 完全な設計 / 仕様
- [../../../../docs/verifiers/overview.md](../../../../docs/verifiers/overview.md) — verifier 全体概要
