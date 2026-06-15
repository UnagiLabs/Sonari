# Sonari System Architecture

> **Purpose**: Provide a single-page overview of how the dapp / Sui / TEE / runner / external services are wired together, and of the **trust boundaries**.
> For details on each domain, see the individual specs: on-chain contracts = [`./contracts_spec.md`](./contracts_spec.md) / contracts overview = [`contracts_overview.md`](contracts_overview.md) / verifier overview = [`verifiers/overview.md`](verifiers/overview.md).
>
> ⚠️ **Draft**: This is continuously updated against the implementation. Items marked `(planned)` are not yet implemented (issue in progress).

## 1. Overall Wiring Diagram

![Sonari system overview](assets/Sonari_SystemFlow_en.svg)

## 2. Trust Boundaries (the core of this system)

| Layer | How trust is handled | Rationale |
|---|---|---|
| External services (USGS / World ID) | **Not trusted** (public; tamper detection is downstream) | The TEE fetches the raw data and verifies it |
| Client (dapp / proof worker) | **Not trusted** | Every claim is verified downstream via Merkle proof / TEE signature |
| **TEE (Nitro Enclave)** | **The only root of trust.** Keys live inside the enclave; attested by PCR | `metadata_verifier` performs signature verification per family |
| AWS runner / relayer | Orchestrator that **holds no keys** | Signing is done by the TEE; submission is re-verifiable by anyone |
| Sui public state | Trusted but **third-party re-verifiable** | `home_cell` etc. are public → a forged signature is immediately exposed |

**The crux**: Only the TEE signs, and its inputs (USGS data, World ID proof, public on-chain state) are all public, so **a third party can reproduce the same output and re-check it**. This is Sonari's trust model. A detailed threat model will be prepared separately (→ missing-document issue).

## 3. List of Verifier Families

| family | input | output (signed) | status |
|---|---|---|---|
| earthquake | USGS event | affected-cell root + payload | ✅ Implemented; verified on dev hardware |
| identity | World ID (Orb) proof | IdentityVerificationRecord | ✅ Implemented |
| census | affected-cell leaves + membership snapshot | per-band count | ❌ Planned #302/#303/#304 |

> The on-chain `metadata_verifier` signing families are **`earthquake` / `identity` / `census`**. The identity verifier lives in the `membership/` folder and its runner kind is `membership_identity`, but its signing family / intent is `identity`. `residence` is enforced by a Merkle proof (client/worker → re-checked by Move), not by a TEE signing family.

## 4. Main Data Flows (3 paths)

1. **Earthquake**: USGS → watcher → earthquake TEE (signs affected-cell root) → relayer → `disaster_event` (Campaign auto-created #301) → census (#304) → `set_floor_census` → floor payout begins.
2. **Identity verification**: dapp (World ID/IDKit) → runner → membership/identity TEE → relayer → `identity_registry` / `membership`.
3. **Funds**: donation `donation` → Pool → claim `claim` → floor/main payout `payout` (rework #300).

## 5. Implemented / Planned Boundaries

- ✅ **Implemented**: dapp production (sonari.help), earthquake/membership/identity/residence verifier, runner, relayer, proof worker, current Move package.
- ⚠️ **Under rework (#300)**: fund flow (4 Pools, floor/main payout, version guard). The legacy `program`/`payout_policy` are slated for removal.
- ❌ **Not yet implemented**: census worker (#304), indexer (avoided for now with the RPC-based MVP). (`schemas/` already exists as the cross-language contract — JSON Schemas, BCS layout docs, and golden vectors.)

---

# Sonari システム全体アーキテクチャ（日本語）

> **目的**: dapp / Sui / TEE / runner / 外部サービスの配線と **信頼境界** を1枚で俯瞰する。
> 個別ドメインの詳細は各仕様へ: オンチェーン契約=[`./contracts_spec.md`](./contracts_spec.md) / コントラクト概要=[`contracts_overview.md`](contracts_overview.md) / verifier 概要=[`verifiers/overview.md`](verifiers/overview.md)。
>
> ⚠️ **ドラフト**: 実装と突合して継続更新する。`(計画)` 注記は未実装（issue 進行中）。

## 1. 全体配線図

![Sonari システム全体図](assets/Sonari_SystemFlow_en.svg)

## 2. 信頼境界（このシステムの核）

| 層 | 信頼の扱い | 根拠 |
|---|---|---|
| 外部サービス (USGS / World ID) | **信頼しない**（公開・改ざん検知は下流） | TEE が原データを取得し検証 |
| クライアント (dapp / proof worker) | **信頼しない** | 全ての主張は Merkle proof / TEE 署名で下流検証 |
| **TEE (Nitro Enclave)** | **唯一の信頼の起点**。鍵は enclave 内、PCR でアテスト | `metadata_verifier` が family 別に署名検証 |
| AWS runner / relayer | **鍵を持たない**オーケストレータ | 署名は TEE、投入は誰でも検算可能 |
| Sui 公開状態 | 信頼するが**第三者が再現検証可能** | `home_cell` 等が公開 → 嘘の署名は即バレる |

**核心**: 署名は TEE のみが行い、その入力（USGS データ・World ID proof・公開オンチェーン状態）は全て公開なので、**第三者が同じ出力を再現して検算できる**。これが Sonari の信頼モデル。詳細な脅威モデルは別途整備予定（→ 不足ドキュメント issue）。

## 3. verifier family 一覧

| family | 入力 | 出力（署名） | 状況 |
|---|---|---|---|
| earthquake | USGS イベント | 被災セル root + payload | ✅ 実装・dev実機検証済 |
| identity | World ID (Orb) proof | IdentityVerificationRecord | ✅ 実装 |
| census | 被災セル leaves + membership snapshot | band別カウント | ❌ 計画 #302/#303/#304 |

> on-chain `metadata_verifier` の署名 family は **`earthquake` / `identity` / `census`** の3つ。identity verifier は `membership/` フォルダにあり runner kind は `membership_identity` だが、署名 family / intent は `identity`。`residence` は TEE 署名 family ではなく Merkle proof（client/worker が生成し Move が再検証）で担保する。

## 4. 主要データフロー（3経路）

1. **地震**: USGS → watcher → earthquake TEE（被災セル root 署名）→ relayer → `disaster_event`（Campaign 自動作成 #301）→ census（#304）→ `set_floor_census` → 床払い開始。
2. **本人確認**: dapp（World ID/IDKit）→ runner → membership/identity TEE → relayer → `identity_registry` / `membership`。
3. **資金**: 寄付 `donation` → Pool → 申請 `claim` → 床払い/本払い `payout`（改修 #300）。

## 5. 実装済み / 計画中の境界

- ✅ **実装済**: dapp 本番(sonari.help)、earthquake/membership/identity/residence verifier、runner、relayer、proof worker、現行 Move package。
- ⚠️ **改修中 (#300)**: 資金フロー（4 Pool・床払い/本払い・version ガード）。旧 `program`/`payout_policy` は廃止予定。
- ❌ **未実装**: census worker (#304)、indexer（RPC版 MVP で当面回避）。（`schemas/` は JSON Schema・BCS layout docs・golden vector を含む cross-language 契約として既に存在する。）
