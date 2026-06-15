# Sonari Documentation

Welcome — this folder is the single place to understand Sonari end to end. If you are reviewing the project, read in the order below.

![Sonari system overview](assets/Sonari_SystemFlow_en.svg)

## Reading Order

1. **Vision & problem** — why Sonari exists and the problem it tackles
   - [defi_payments_problem_statement.md](defi_payments_problem_statement.md) — the hackathon problem statement
   - [business_logic.md](business_logic.md) — business assumptions and the relief model
2. **Architecture** — the whole system and its trust boundaries on one page
   - [architecture.md](architecture.md) — dapp / Sui / TEE / runner / external services wiring
   - [tech_stack.md](tech_stack.md) — technology choices
3. **Contracts** — the on-chain rules that hold and release funds
   - [contracts_overview.md](contracts_overview.md) — plain-language overview and module map
   - [contracts_spec.md](contracts_spec.md) — the full Move design spec
   - [fund_flow_spec.md](fund_flow_spec.md) — fund-flow design, migration, and gaps (developer-facing)
   - [donation_flow.md](donation_flow.md) — donor / recipient flow
4. **Verifiers** — the TEE side that produces the signed results Move verifies
   - [verifiers/overview.md](verifiers/overview.md) — start here, then the per-component docs in `verifiers/`
5. **Web app** — the product surface
   - [webapp.md](webapp.md) — UI design and flows
6. **Operations** — running, deploying, and re-publishing the system
   - [operations/README.md](operations/README.md) — operational index

## Folder Map

| Path | What it holds |
| --- | --- |
| `architecture.md`, `business_logic.md`, `tech_stack.md`, `defi_payments_problem_statement.md` | Concept-level docs for reviewers |
| `contracts_overview.md`, `contracts_spec.md`, `fund_flow_spec.md`, `donation_flow.md` | On-chain contract design |
| `webapp.md` | Web app / UI design |
| `verifiers/` | Per-component TEE verifier docs (earthquake, identity, proof workers) |
| `operations/` | Runbooks: deploy, admin setup, AWS smoke, data pipelines |
| `design/` | Focused design notes referenced by code |
| `assets/` | Diagrams and on-chain display assets (`display/*.svg` are fixed on-chain paths) |

---

# Sonari ドキュメント（日本語）

ようこそ。このフォルダは Sonari を端から端まで理解するための単一の入口です。レビューする場合は、以下の順で読んでください。

![Sonari システム全体図](assets/Sonari_SystemFlow_en.svg)

## 読む順序

1. **ビジョンと課題** — Sonari がなぜ存在し、どんな課題に取り組むか
   - [defi_payments_problem_statement.md](defi_payments_problem_statement.md) — ハッカソンの課題文
   - [business_logic.md](business_logic.md) — 事業前提と支援モデル
2. **アーキテクチャ** — システム全体と信頼境界を1枚で
   - [architecture.md](architecture.md) — dapp / Sui / TEE / runner / 外部サービスの配線
   - [tech_stack.md](tech_stack.md) — 技術選定
3. **コントラクト** — 資金を保持し放出する on-chain ルール
   - [contracts_overview.md](contracts_overview.md) — 平易な概要とモジュール一覧
   - [contracts_spec.md](contracts_spec.md) — 完全な Move 設計仕様
   - [fund_flow_spec.md](fund_flow_spec.md) — 資金フロー設計・移行・ギャップ（開発者向け）
   - [donation_flow.md](donation_flow.md) — 寄付者 / 受給者フロー
4. **Verifier** — Move が検証する署名済み結果を作る TEE 側
   - [verifiers/overview.md](verifiers/overview.md) — まずここから。続けて `verifiers/` 配下の各コンポーネント資料へ
5. **Web アプリ** — プロダクトの表側
   - [webapp.md](webapp.md) — UI 設計とフロー
6. **運用** — 稼働・デプロイ・再 publish
   - [operations/README.md](operations/README.md) — 運用インデックス

## フォルダ構成

| パス | 内容 |
| --- | --- |
| `architecture.md`, `business_logic.md`, `tech_stack.md`, `defi_payments_problem_statement.md` | 審査員向けの概念資料 |
| `contracts_overview.md`, `contracts_spec.md`, `fund_flow_spec.md`, `donation_flow.md` | on-chain コントラクト設計 |
| `webapp.md` | Web アプリ / UI 設計 |
| `verifiers/` | TEE verifier の各コンポーネント資料（earthquake, identity, proof worker） |
| `operations/` | Runbook: デプロイ・admin setup・AWS smoke・データパイプライン |
| `design/` | コードから参照される設計メモ |
| `assets/` | 図と on-chain display 資産（`display/*.svg` は on-chain 固定パス） |
