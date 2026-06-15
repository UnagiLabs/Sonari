# Membership Verifiers

`membership/verifiers` は、identity verification 以外の membership metadata verifier を置く領域です。

現在は residence と student の設計 / 予約領域があります。本人確認 provider である KYC / World ID の実装は `membership/tee/` と `membership/shared/` が担当します。

## フォルダ

| フォルダ | 役割 |
| --- | --- |
| `residence/` | 自己申告の居住 H3 cell が登録可能な陸地 cell かを検証する設計領域 |
| `student/` | 将来の student eligibility verifier 用の予約領域 |

## identity verifier との違い

Identity verifier は、Membership SBT の本人確認状態を更新するための result を作ります。

Residence や student verifier は、membership に紐づく追加 metadata や eligibility を検証するための result を作ります。本人確認済みかどうか、重複登録をどう扱うか、World ID proof が有効かどうかは identity verifier の責務です。

## 地震 verifier との違い

Membership verifier は個人または membership metadata を扱います。地震 verifier の affected cells や disaster event root は作りません。

どちらも signed payload を contract に渡しますが、source、rejection rule、field order、署名対象 bytes は別契約です。

---

**Parent docs**: [../../../../docs/verifiers/identity.md](../../../../docs/verifiers/identity.md) — component overview & full spec.
**親資料**: 同上（上位コンポーネントの概要・完全仕様）。
