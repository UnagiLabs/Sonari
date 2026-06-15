# Sonari System Architecture

![Sonari system overview](assets/Sonari_SystemFlow_en.svg)

> **Purpose**: Provide a single-page overview of how the dapp / Sui / TEE / runner / external services are wired together, and of the **trust boundaries**.
> For details on each domain, see the individual specs: fund flow = [`fund_flow_spec.md`](./fund_flow_spec.md) / on-chain contracts = [`./contracts_spec.md`](./contracts_spec.md) / contracts overview = [`contracts_overview.md`](contracts_overview.md) / verifier overview = [`verifiers/overview.md`](verifiers/overview.md) / Web App = [`webapp.md`](./webapp.md) / tech stack = [`tech_stack.md`](./tech_stack.md).
>
> ⚠️ **Draft**: This is continuously updated against the implementation. Items marked `(planned)` are not yet implemented (issue in progress).

## 1. Overall Wiring Diagram

```mermaid
flowchart TB
    subgraph EXT["External services (not a root of trust; public data)"]
        USGS["USGS<br/>earthquake data"]
        WORLD["World ID<br/>Orb / IDKit v4"]
    end

    subgraph CLIENT["Client (not trusted; all verification is downstream)"]
        DAPP["dapp (Next.js)<br/>sonari.help<br/>Cloudflare Workers/OpenNext"]
        subgraph WORKERS["Cloudflare Workers + R2"]
            ACPW["affected-cells-proof-worker"]
            RPW["residence-proof-worker"]
        end
        DAPP --> WORKERS
    end

    subgraph TEE["🔒 TEE / Nitro Enclave (trust boundary: attested by PCR; keys live inside the enclave)"]
        EQV["earthquake verifier<br/>USGS→affected-cell root + payload signature"]
        MIV["membership / identity verifier<br/>World ID→identity check→signature"]
        CENSUS["census worker (planned #304)<br/>per-band count→signature"]
    end

    subgraph AWS["AWS infrastructure (orchestration; holds no keys)"]
        WATCHER["earthquake watcher (Lambda)"]
        RUNNER["sonari-verifier-runner<br/>driven by DynamoDB Streams"]
        RELAYER["relayer<br/>on-chain submission"]
        DDB[("DynamoDB<br/>job state / streams")]
        WATCHER --> RUNNER
        RUNNER <--> DDB
        RUNNER --> RELAYER
    end

    subgraph STORE["Distributed storage"]
        WALRUS[("Walrus<br/>affected-cell archive / evidence manifest")]
        R2[("Cloudflare R2<br/>proof artifacts")]
    end

    subgraph CHAIN["⛓️ Sui (testnet) — Move package (public state = third-party re-verifiable)"]
        MV["metadata_verifier<br/>TEE signature verification (verifier family)"]
        MEM["membership / identity_registry"]
        DE["disaster_event / affected_cell"]
        RES["allowed_residence_cell"]
        FUND["donation / claim / pools<br/>payout・campaign・category_pool (under rework #300)"]
        MV -.signature verification.-> MEM & DE & FUND
    end

    USGS --> WATCHER
    WATCHER --> EQV
    EQV --> WALRUS
    EQV --> RELAYER
    RELAYER --> DE

    WORLD --> DAPP
    DAPP -->|forward idkit_response| RUNNER
    RUNNER --> MIV
    MIV --> RELAYER
    RELAYER --> MEM

    RELAYER -.downstream trigger (planned #304).-> CENSUS
    WALRUS -.affected-cell leaves.-> CENSUS
    MEM -.RPC: multiGetObjects.-> CENSUS
    CENSUS -.set_floor_census (planned).-> FUND

    DAPP -->|read public state| CHAIN
    ACPW --> R2
    RPW --> R2
    DAPP -->|claim/register with Merkle proof| FUND
    DAPP --> RES
```

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
| membership | World ID proof | identity-check record | ✅ Implemented |
| identity | World ID (Orb) | IdentityVerificationRecord | ✅ Implemented |
| residence | H3 residence cell + Merkle | (proof is in client/worker) | ✅ Implemented |
| **census (=5)** | affected-cell leaves + membership snapshot | per-band count | ❌ Planned #302/#303/#304 |

## 4. Main Data Flows (3 paths)

1. **Earthquake**: USGS → watcher → earthquake TEE (signs affected-cell root) → relayer → `disaster_event` (Campaign auto-created #301) → census (#304) → `set_floor_census` → floor payout begins.
2. **Identity verification**: dapp (World ID/IDKit) → runner → membership/identity TEE → relayer → `identity_registry` / `membership`.
3. **Funds**: donation `donation` → Pool → claim `claim` → floor/main payout `payout` (rework #300).

## 5. Implemented / Planned Boundaries

- ✅ **Implemented**: dapp production (sonari.help), earthquake/membership/identity/residence verifier, runner, relayer, proof worker, current Move package.
- ⚠️ **Under rework (#300)**: fund flow (4 Pools, floor/main payout, version guard). The legacy `program`/`payout_policy` are slated for removal.
- ❌ **Not yet implemented**: census worker (#304), `schemas/`(#302), indexer (avoided for now with the RPC-based MVP).

---

# Sonari システム全体アーキテクチャ（日本語）

> **目的**: dapp / Sui / TEE / runner / 外部サービスの配線と **信頼境界** を1枚で俯瞰する。
> 個別ドメインの詳細は各仕様へ: 資金フロー=[`fund_flow_spec.md`](./fund_flow_spec.md) / オンチェーン契約=[`./contracts_spec.md`](./contracts_spec.md) / コントラクト概要=[`contracts_overview.md`](contracts_overview.md) / verifier 概要=[`verifiers/overview.md`](verifiers/overview.md) / Web App=[`webapp.md`](./webapp.md) / 技術スタック=[`tech_stack.md`](./tech_stack.md)。
>
> ⚠️ **ドラフト**: 実装と突合して継続更新する。`(計画)` 注記は未実装（issue 進行中）。

## 1. 全体配線図

```mermaid
flowchart TB
    subgraph EXT["外部サービス（信頼の起点ではない・公開データ）"]
        USGS["USGS<br/>地震データ"]
        WORLD["World ID<br/>Orb / IDKit v4"]
    end

    subgraph CLIENT["クライアント（信頼しない / 検証は全て下流）"]
        DAPP["dapp (Next.js)<br/>sonari.help<br/>Cloudflare Workers/OpenNext"]
        subgraph WORKERS["Cloudflare Workers + R2"]
            ACPW["affected-cells-proof-worker"]
            RPW["residence-proof-worker"]
        end
        DAPP --> WORKERS
    end

    subgraph TEE["🔒 TEE / Nitro Enclave（信頼境界：PCR でアテスト・鍵は enclave 内）"]
        EQV["earthquake verifier<br/>USGS→被災セル root+payload 署名"]
        MIV["membership / identity verifier<br/>World ID→本人確認→署名"]
        CENSUS["census worker (計画 #304)<br/>band別カウント→署名"]
    end

    subgraph AWS["AWS インフラ（オーケストレーション・鍵は持たない）"]
        WATCHER["earthquake watcher (Lambda)"]
        RUNNER["sonari-verifier-runner<br/>DynamoDB Streams 駆動"]
        RELAYER["relayer<br/>on-chain 投入"]
        DDB[("DynamoDB<br/>job state / streams")]
        WATCHER --> RUNNER
        RUNNER <--> DDB
        RUNNER --> RELAYER
    end

    subgraph STORE["分散ストレージ"]
        WALRUS[("Walrus<br/>被災セルアーカイブ / evidence manifest")]
        R2[("Cloudflare R2<br/>proof artifacts")]
    end

    subgraph CHAIN["⛓️ Sui (testnet) — Move package（公開状態 = 第三者検算可能）"]
        MV["metadata_verifier<br/>TEE署名検証 (verifier family)"]
        MEM["membership / identity_registry"]
        DE["disaster_event / affected_cell"]
        RES["allowed_residence_cell"]
        FUND["donation / claim / pools<br/>payout・campaign・category_pool (改修中 #300)"]
        MV -.署名検証.-> MEM & DE & FUND
    end

    USGS --> WATCHER
    WATCHER --> EQV
    EQV --> WALRUS
    EQV --> RELAYER
    RELAYER --> DE

    WORLD --> DAPP
    DAPP -->|idkit_response 転送| RUNNER
    RUNNER --> MIV
    MIV --> RELAYER
    RELAYER --> MEM

    RELAYER -.後段トリガ (計画 #304).-> CENSUS
    WALRUS -.被災セル leaves.-> CENSUS
    MEM -.RPC: multiGetObjects.-> CENSUS
    CENSUS -.set_floor_census (計画).-> FUND

    DAPP -->|read 公開状態| CHAIN
    ACPW --> R2
    RPW --> R2
    DAPP -->|Merkle proof で claim/register| FUND
    DAPP --> RES
```

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
| membership | World ID proof | 本人確認レコード | ✅ 実装 |
| identity | World ID (Orb) | IdentityVerificationRecord | ✅ 実装 |
| residence | H3 居住セル + Merkle | （proof は client/worker） | ✅ 実装 |
| **census (=5)** | 被災セル leaves + membership snapshot | band別カウント | ❌ 計画 #302/#303/#304 |

## 4. 主要データフロー（3経路）

1. **地震**: USGS → watcher → earthquake TEE（被災セル root 署名）→ relayer → `disaster_event`（Campaign 自動作成 #301）→ census（#304）→ `set_floor_census` → 床払い開始。
2. **本人確認**: dapp（World ID/IDKit）→ runner → membership/identity TEE → relayer → `identity_registry` / `membership`。
3. **資金**: 寄付 `donation` → Pool → 申請 `claim` → 床払い/本払い `payout`（改修 #300）。

## 5. 実装済み / 計画中の境界

- ✅ **実装済**: dapp 本番(sonari.help)、earthquake/membership/identity/residence verifier、runner、relayer、proof worker、現行 Move package。
- ⚠️ **改修中 (#300)**: 資金フロー（4 Pool・床払い/本払い・version ガード）。旧 `program`/`payout_policy` は廃止予定。
- ❌ **未実装**: census worker (#304)、`schemas/`(#302)、indexer（RPC版 MVP で当面回避）。
