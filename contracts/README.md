# Sonari Sui Contracts

The Move package that holds donated funds and enforces every payout rule on Sui. It accepts donations, recognizes signed disaster events, confirms identity, and gates relief claims — re-verifying each TEE signature on-chain before money moves.

- **Role**: on-chain custody of funds and final, public verification of every signed result
- **Trust boundary**: trusts nothing from watchers, relayers, the frontend, or storage — only enclave-signed payloads it can re-check at the Sui boundary (fail-closed)

## Where to Read More

- [docs/contracts_overview.md](../docs/contracts_overview.md) — plain-language overview: what the contracts do, the Nautilus pattern, trust model, and module map
- [docs/internal/contracts_spec.md](../docs/internal/contracts_spec.md) — full Move design spec: pools, object layouts, exact amounts, security and test requirements
- [docs/verifiers/overview.md](../docs/verifiers/overview.md) — the TEE / Nautilus side that produces the signed results these contracts verify

---

# Sonari Sui Contracts（日本語）

寄付資金を保持し、Sui 上ですべての給付ルールを強制する Move パッケージです。寄付を受け取り、署名済みの災害イベントを認識し、本人確認を行い、支援申請をゲートします。資金が動く前に、各 TEE 署名を on-chain で再検証します。

- **役割**: 資金の on-chain 保管と、すべての署名済み結果に対する最終的・公開の検証
- **信頼境界**: watcher / relayer / frontend / storage を信頼せず、Sui 境界で再検証できる enclave 署名済み payload のみを信頼（fail-closed）

## 詳細資料

- [docs/contracts_overview.md](../docs/contracts_overview.md) — 平易な概要: コントラクトの役割、Nautilus パターン、信頼モデル、モジュール一覧
- [docs/internal/contracts_spec.md](../docs/internal/contracts_spec.md) — 完全な Move 設計仕様: Pool・オブジェクト設計・正確な金額・セキュリティ / テスト要件
- [docs/verifiers/overview.md](../docs/verifiers/overview.md) — これらのコントラクトが検証する署名済み結果を作る側（TEE / Nautilus）
