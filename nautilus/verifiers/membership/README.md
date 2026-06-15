# Sonari Identity Verifiers

Membership identity verifier — Membership SBT の本人確認状態を、KYC / World ID provider の検証結果で更新する verifier 群です。

- **Role**: World ID / KYC proof を検証し、verified な本人確認結果を contract 向け署名 payload にする。
- **Trust boundary**: 本検証と署名は TEE / verifier 側で行い、worker / relayer / dApp は意味を変えずに配送するだけ。

## Where to Read More
- [../../../docs/verifiers/identity.md](../../../docs/verifiers/identity.md) — full design / spec
- [../../../docs/verifiers/overview.md](../../../docs/verifiers/overview.md) — verifier system overview

---

# Sonari Identity Verifiers（日本語）

Membership identity verifier — Membership SBT の本人確認状態を、KYC / World ID provider の検証結果で更新する verifier 群です。

- **役割**: World ID / KYC proof を検証し、verified な本人確認結果を contract 向け署名 payload にする。
- **信頼境界**: 本検証と署名は TEE / verifier 側で行い、worker / relayer / dApp は意味を変えずに配送するだけ。

## 詳細資料
- [../../../docs/verifiers/identity.md](../../../docs/verifiers/identity.md) — 完全な設計 / 仕様
- [../../../docs/verifiers/overview.md](../../../docs/verifiers/overview.md) — verifier 全体概要
