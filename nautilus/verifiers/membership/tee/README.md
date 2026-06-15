# Membership TEE

Membership SBT の本人確認結果を作る Rust crate。World ID proof を検証し、verified な結果だけを BCS payload にして署名します。

- **Role**: World ID proof を検証し、verified result の payload BCS bytes に署名する TEE 境界。
- **Trust boundary**: 署名できるのは `verified` のみ。worker / relayer は結果の意味を変えず、Move は署名済み payload だけを信頼する。

## Where to Read More
- [../../../../docs/verifiers/identity_tee.md](../../../../docs/verifiers/identity_tee.md) — full design / spec
- [../../../../docs/verifiers/overview.md](../../../../docs/verifiers/overview.md) — verifier system overview

---

# Membership TEE（日本語）

Membership SBT の本人確認結果を作る Rust crate。World ID proof を検証し、verified な結果だけを BCS payload にして署名します。

- **役割**: World ID proof を検証し、verified result の payload BCS bytes に署名する TEE 境界。
- **信頼境界**: 署名できるのは `verified` のみ。worker / relayer は結果の意味を変えず、Move は署名済み payload だけを信頼する。

## 詳細資料
- [../../../../docs/verifiers/identity_tee.md](../../../../docs/verifiers/identity_tee.md) — 完全な設計 / 仕様
- [../../../../docs/verifiers/overview.md](../../../../docs/verifiers/overview.md) — verifier 全体概要
