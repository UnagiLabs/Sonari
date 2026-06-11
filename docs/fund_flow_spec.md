# Sonari 資金フロー実装仕様書（ギャップ分析・移行計画）

本書は資金フローの**現状実装とのギャップ分析・移行計画・`business_logic.md` 改訂リスト・
Open Questions** をまとめる補助文書である。

- **オンチェーン設計の正は [contracts/README.md](../contracts/README.md)** である。
  Pool 構成・オブジェクト定義・関数仕様・定数・イベント・床払い/本払いの計算式は README を参照する。
  本書はそれを重複させず、「現行実装からどう移るか」「business_logic.md をどう直すか」に焦点を当てる。
- 寄付者・受給者向けの平易な説明は [donation_flow.md](./donation_flow.md)、
  事業前提は [business_logic.md](./business_logic.md) を参照する。
- 対象地域の登録者数の off-chain 集計（後置センサス）は **GitHub issue #296** を参照する。

**用語**: 用途Pool = **Category Pool** / 特設募金箱 = **Campaign Pool（`Campaign`）** /
最低ラインの支援金 = **床払い（Floor / Round 0）** / 寄付の分配 = **本払い（Round 1 以降）**。

支払いモデルの要点（詳細は README §1・§7・§9）:

| 段階 | 時期 | 資金源 | 金額の決まり方 |
| --- | --- | --- | --- |
| 床払い（Round 0） | Day 0–30、検証完了しだい随時 | **Category + Main を Campaign へ escrow** | 後置センサスで作成直後に floor_ratio を固定 |
| 本払い（Round 1+） | Day 30 / 以後90日ごと | **Campaign のみ** | finalize_round で按分（`min(残高/必要額, 3.0)`） |

---

## 1. 現状実装の調査結果

### 1.1 モジュール一覧（`contracts/sources/`）

| モジュール | 主な struct | 役割 |
|---|---|---|
| `admin` | `AdminCap`, `PauseState` | genesis 初期化（init で MainPool / OperationsPool / 各 Registry / ClaimIndex を作成）、AdminCap ゲートの管理操作、global / target pause |
| `pools` | `MainPool`, `DesignatedPool`, `OperationsPool`（いずれも shared） | USDC 残高保持。deposit / withdraw は `public(package)`。withdraw は Main / Designated のみ（Operations の引き出し関数は無い）。**version フィールドなし** |
| `donation` | `DonorRegistry`, `DonorPass`, `DonationRecord` | 寄付受付。General（100% Main）/ Designated（50% Designated + 50% Main）/ Operations（100% Ops）の3種。DonorPass（soulbound、tier 付き）の発行・履歴記録 |
| `program` | `Program`, `Campaign` | generic な Program / Campaign。Campaign は admin が `claim_start_ms` / `claim_end_ms` を指定して手動作成。`budget_opened` フラグ保持 |
| `payout_policy` | `PayoutPolicy`, `CampaignBudget` | Band 1/2/3 = 50/150/300 USDC の固定額ポリシー（shared）。`CampaignBudget` は admin が手動 open し、designated 80% + main backstop 枠を**open 時の残高スナップショット**で算出 |
| `claim` | `ClaimIndex`, `ClaimReceipt`, `ClaimKey` | `claim_disaster_usdc` が申請＝即時支払い（first-come-first-served）。`quote_usdc` で band 固定額・budget 残・pool 残の min を取り、Designated → Main の順に即時引き落として transfer |
| `disaster_event` | `DisasterRegistry`, `DisasterEvent`, `DisasterCampaignBinding` | enclave 署名済み payload から DisasterEvent を作成。Campaign 紐付けは admin の `bind_disaster_campaign` で**別 tx・手動** |
| `affected_cell` | `AffectedCellLeaf`, `ProofStep` | affected cells Merkle proof 検証（sha2-256、leaf 0x00 / internal 0x01） |
| `allowed_residence_cell` | `AllowedResidenceCellRegistry` | 居住セル allowlist の Merkle root（res7 固定） |
| `membership` | `MembershipRegistry`, `MembershipPass`, `MembershipRecord` | Membership SBT。`account_created_at_ms` / `home_cell` / `home_cell_registered_at_ms` / `terms_version` / `signed_statement_hash` 保持。登録は**無料**。**`home_cell` をイベントに出していない** |
| `identity_registry` | `IdentityRegistry`, `IdentityKey`, `IdentityVerificationRecord` | KYC / World ID の duplicate key binding と本人確認記録 |
| `identity_result_v1` | `IdentityVerificationResult` | TEE 署名済み本人確認結果の BCS decode + 検証 |
| `metadata_verifier` | `VerifierRegistry`, `VerifierConfig`, `EnclaveInstance` | Nautilus enclave の PCR / 鍵管理と署名検証（earthquake = 3 / identity = 4） |
| `payload` | `Payload` | 地震 oracle payload の BCS decode + finalized 検証（`severity_band`・`affected_cells_root`・`occurred_at_ms`・`affected_cell_count` 等）。**登録メンバー数フィールドは無い** |
| `accessor` | — | 外部公開エントリーポイント集約（pause チェック → 各モジュール委譲） |
| `reader` | — | 読み取り専用ヘルパー |

### 1.2 現状の資金フロー（実装ベース）

```text
donate_general_usdc      : 100% → MainPool
donate_designated_usdc   : 50% → DesignatedPool / 50% → MainPool
donate_operations_usdc   : 100% → OperationsPool
claim_disaster_usdc      : 申請と同時に quote_usdc で金額決定し即時支払い
                           （DesignatedPool → MainPool の順、CampaignBudget の枠内・早い者勝ち）
```

### 1.3 確定設計（README）とのギャップ分析

| # | 項目 | 現状実装 | あるべき姿（README） | 規模 |
|---|---|---|---|---|
| G1 | Pool 構成 | `MainPool` / `DesignatedPool`（generic）/ `OperationsPool` の3種 | Category / Campaign / Main / Operations の4種。`DesignatedPool` + `program::Campaign` + `CampaignBudget` を単一 `Campaign` へ統合し `CategoryPool` を新設 | 大 |
| G2 | Category Pool | 存在しない | 用途ごと常設。平常時寄付の受け皿 + **床払いの第1資金源**。MVP は earthquake のみ | 新規 |
| G3 | 寄付分割 | Designated 50/50、General 100% Main、Ops 直接 100% | Campaign/Category 宛て 90/5/5、指定なし 95/5、Ops は源泉徴収のみ | 大 |
| G4 | Operations Donation | `donate_operations_usdc` 存在（100% Ops 直接） | 廃止。Ops は源泉徴収分のみ | 中 |
| G5 | ops cap | なし | Campaign 宛てのみ `campaign_ops_cap`（50,000 USDC）、超過分 Main。Category/指定なしは非適用 | 新規 |
| G6 | Campaign 自動作成 | DisasterEvent / Campaign / binding / budget open が**4つの別 admin 操作** | finalize と**同一 tx**で自動作成、hazard_type から Category Pool と自動1対1紐付け、裁量なし | 大 |
| G7 | **床払い（Round 0）** | なし（即時支払いはあるが Campaign 残から早い者勝ち） | **後置センサスで floor_ratio を作成直後に固定 → Category/Main escrow → Day 0–30 に検証完了者へ固定額即時払い → Day 30 未消化返還**。Campaign は使わない | 新規（コア） |
| G8 | **対象地域の登録者数の供給** | なし | **後置センサス（off-chain 集計→署名→`set_floor_census`、#296）**。オンチェーン集計は不可能（DF 列挙不可・affected cells は root のみ・最大100万セル・cutoff 履歴） | 新規（コア） |
| G9 | 本払い方式 | 申請＝即時支払い（早い者勝ち。後続ほど減額） | finalize_round で按分 → claim_payout は保存値読むだけ。全員同比率。**Campaign のみ**（補填なし） | 大 |
| G10 | 支払額計算 | `quote_usdc`: 固定額と残額の min | 床: `目標額 × min(0.5, floor_budget/max_liability)`。本払い: `目標額 × min(残高/必要額, 3.0)` | 大 |
| G11 | ラウンド制 | なし（1回限り） | Day 30 に Round 1、以後90日ごと Campaign 残高を再分配。終了後 residual sweep（Main へ） | 新規 |
| G12 | 補填の置き場所 | `CampaignBudget` の main backstop（即時支払い時に Main から補填） | **補填は床払いのみ**（Category ÷5 → Main ×20%, reserve floor, escrow）。本払いは Campaign 残のみで補填しない | 大 |
| G13 | パラメータ管理 | `PayoutPolicy`（独立 shared、admin 差し替え可） | モジュール定数 + Campaign 作成時スナップショット。`PayoutPolicy` / `CampaignBudget` 廃止 | 大 |
| G14 | version ガード | **どの shared オブジェクトにも `version` なし** | 全 shared に `version`、全 public 関数先頭で assert（既存は新 struct で再作成） | 新規 |
| G15 | 寄付/申請期間 | 寄付は常時可、申請は admin 任意指定 | Campaign 寄付30日（終了後 Main ルーティング）・申請21日（スナップショット）。延長のみ admin 可 | 中 |
| G16 | admin 権限 | campaign 作成・budget open・policy 作成・binding すべて裁量 | Category Pool 新設・期間延長・pause・除外・ops 支出のみ。**floor_ratio 手動設定不可** | 大 |
| G17 | census family | metadata_verifier は earthquake(3)/identity(4) のみ | **census family(=5)** を追加し `set_floor_census` で署名検証 | 新規 |
| G18 | home_cell イベント | 未発行（`MembershipPassIssued` は cell 非包含、`set_home_cell` 無発行） | `HomeCellRegistered { lineage, home_cell, registered_at }` を追加（#296 indexer 前提） | 新規 |
| G19 | OpsSpend | OperationsPool の引き出し関数が無い | 金額・送金先・reason_code をイベント記録する支出関数 | 新規 |
| G20 | リアルタイム表示用フィールド | `total_received_usdc` のみ | Campaign: 寄付累計・band 別検証済み数・floor_ratio・床/本払い済み総額。Category: 残高・流入・床拠出累計 | 中 |

**`business_logic.md` §10 の既知差分（ほぼ解消済み）**

| §10 項目 | 現状 |
|---|---|
| 登録時の fee 前提を外す | ✅ 解消済み（`register_member` は無料） |
| 別受取先の概念を外す | ✅ 解消済み（受取先は SBT owner 固定） |
| Claim 条件へ IdentityRegistry を追加 | ✅ 解消済み |
| `account_created_at_ms` の cutoff 判定 | ✅ 解消済み |
| `home_cell_registered_at_ms` の cutoff 判定 | ✅ 解消済み |
| duplicate key registry | ✅ 解消済み（`IdentityRegistry`） |
| 本人確認の段階評価係数を外す | ✅ 解消済み |

残る大きな差分は本書が対象とする**資金フロー（G1–G20）**である。

---

## 2. オブジェクト・関数設計

オブジェクト定義（`CategoryPool` / `Campaign`（床 escrow 含む）/ `MainPool` / `OperationsPool`）、
関数仕様（`donate_*` / `create_category_pool` / `create_campaign` / `set_floor_census` /
`claim_floor` / `return_floor_budget` / `submit_claim` / `verify_claim` / `finalize_round` /
`claim_payout` / `sweep_residual` / `spend_operations`）、床払い/本払いの計算式、イベント、定数表は
**[contracts/README.md](../contracts/README.md) §5–§13 を正とする**。本書では重複させない。

設計の骨子（README からの要約）:

- 旧 `DesignatedPool` + `program::Campaign` + `CampaignBudget` を**単一 `Campaign`** に統合。
  資金（本払い `balance`）・床 escrow（`floor_balance`）・スナップショット済みパラメータ・締切・
  ラウンド状態を1オブジェクトで持つ。
- `CategoryPool` を新設（用途ごと常設、床払いの第1資金源）。
- 床予算は **Campaign へ物理 escrow**（Category/Main から move）し、未消化分を Day 30 に按分返還。
  これにより Category/Main 側の earmark 会計が不要になる（可処分 = 現在残高）。
- 全 shared に `version`。既存オブジェクトはフィールド追加不可のため新 struct で再作成。

---

## 3. 移行計画（現行 → V2）

1. 新 package を upgrade publish（旧 struct は残るが新規エントリーは V2 のみ）。
2. genesis 関数で `MainPool` / `OperationsPool`（version 付き）/ `CategoryRegistry` /
   earthquake `CategoryPool` を作成（`GenesisObjectCreated` / `CategoryPoolCreated` 発行）。
3. AdminCap ゲートの一回限り関数で旧 `MainPool` / `OperationsPool` / 各 `DesignatedPool` の残高を
   V2 へ移送（移送イベント記録）。**旧入金関数は新 package で abort 実装に差し替えて遮断する**
   （旧 struct に version が無いため、新ロジックでの呼び出しを止める唯一の手段）。
4. `metadata_verifier` に census family（=5）の config / 鍵を登録（#296 の署名方式決定後）。
5. dapp / relayer / scripts の参照オブジェクト ID を更新（`Published.toml` 由来の導出を維持）。
6. 進行中 Campaign の扱い: dev / testnet 段階のため基本ゼロ前提。残存する場合は claim 済みを
   有効とし残額を Main(V2) へ sweep する一回限り関数を用意（イベント記録）。本番 migrate 前に
   残存 Campaign ゼロを運用手順で確認する。

version ガードの実装パターン・migrate 関数・struct 拡張方針は README §12 を参照。

---

## 4. `business_logic.md` 改訂リスト（書き換えは行わない。リストのみ）

### §4（支払額の考え方）

| 現記述 | 改訂案 |
|---|---|
| 「基本の一時支援額は次を目安にする。Band 1: $50 / Band 2: $150 / Band 3: $300」 | 「Band 目標額（保証額ではない）: 50 / 150 / 300 USDC（比率 1:3:6、地域係数なし）。支払いは2段階。**床払い**＝後置センサスで作成直後に `目標額 × min(0.5, 床予算/max_liability)` を固定し検証完了者へ即時。**本払い**＝finalize_round で `目標額 × min(残高/必要額, 3.0)`」へ書き換え |
| 「Pool が不足する場合は、CampaignBudget の中で支払う。」 | 削除。「床払いの不足時のみ Category(可処分÷5) → Main(可処分×20%, reserve floor) の2層で escrow して床を作る。本払い（Campaign 残のみ）では補填しない」へ（CampaignBudget は廃止） |
| 「将来、対象者全体を見た按分を追加できる。」 | 削除（按分は確定設計のコア。締切後一括計算・早い者勝ちなしを明記） |
| （追記） | 床払い（Round 0、即時）と本払い（Round 1 以降、90日ごと、Campaign 残のみ）の2段階・残額の最終 sweep は Main へ、を新設の節として追加 |

### §8（資金プール）

| 現記述 | 改訂案 |
|---|---|
| Pool 表「Main / Designated Relief / Operations」 | 4 Pool へ差し替え:「Category Pool（用途ごと常設・平常時寄付・**床払いの第1資金源**。MVP は earthquake のみ）/ Campaign Pool（災害ごと自動作成・期間限定・**本払い専用**）/ Main Pool（指定なし寄付・**床払いの第2資金源**・sweep 受け皿）/ Operations Pool（源泉徴収のみ）」 |
| 「General Donation -> 100% Main Pool」 | 「指定なし寄付: 95% Main / 5% Ops」 |
| 「Designated Donation -> 50% Designated / 50% Main」 | 「特定災害指定（Campaign 宛て）: 90% Campaign / 5% Main / 5% Ops。用途指定（Category 宛て）: 90% Category / 5% Main / 5% Ops」 |
| 「Operations Donation -> 100% Operations Pool」 | 削除（Operations Donation 廃止。Ops は源泉徴収のみ） |
| （追記） | campaign_ops_cap（50,000 USDC、Campaign 宛てのみ、超過分 Main）、Main/Category/Campaign から運営宛の引き出し関数は存在しないこと、Ops 支出はイベント記録必須、Campaign 寄付期間（30日）終了後の寄付は Main へルーティング、を追加 |

### §9（災害支払いの流れ）

| 現記述 | 改訂案 |
|---|---|
| 「Sponsor donates to Earthquake Pool -> … -> Earthquake Pool pays first -> Main Pool covers allowed shortage -> Relief Receipt is issued」の即時支払いフロー | 2段階フローへ全面書き換え: `災害 finalize（Campaign 自動作成・Category Pool 自動紐付け・同一 tx）→ set_floor_census（登録者数を後置センサスで集計署名→floor_ratio 確定→Category/Main escrow）→ Day 0–30 床払い（検証完了しだい固定額即時、Campaign 不使用）→ Day 30 床予算返還＋Round 1 finalize（Campaign 残のみ按分）→ claim_payout → 90日ごと再分配 → residual sweep（Main へ）` |
| （追記） | finalize と claim の分離、生のプール残高から金額を導出しない、二重受取防止（床は pass 単位・本払いは round 単位）、検証遅延者は検証完了後のラウンドから参加、admin の関与は Category Pool 新設・延長・pause・除外・ops 支出のみ、対象地域の登録者数はオンチェーン集計不可で後置センサス（#296）に依存、を明記 |

### §10（現在の Move 実装との差分）

- 解消済み項目（fee、別受取先、IdentityRegistry、cutoff 2種、duplicate key、段階評価係数）を
  「解消済み」へ更新し、残課題を本書のギャップ（G1–G20）への参照に差し替える。

---

## 5. Open Questions

オンチェーン設計に関わる OQ は **README §18** を正とする（reserve floor 絶対額 / `CATEGORY_ANNUAL_EVENT_DIVISOR`=5 較正 / 登録者数の供給方式 / 床払い受取期限 / センサス未到達 fallback / ラウンド終了閾値 / finalize・返還・センサス submit の実行者 / 検証遅延者の状態遷移 / 除外の遡及 / revision 更新時の Campaign / severity_band 代理）。

本書（移行・運用）固有の OQ:

| # | 論点 | 推奨案 |
|---|---|---|
| OQ-M1 | 後置センサスの署名方式 | (a) census 専用鍵を metadata_verifier に登録 / (b) membership enclave でアテステーション。#296 で決定。MVP は (a)、検算可能性で担保 |
| OQ-M2 | `HomeCellRegistered` イベント追加を本リワークに含めるか | 含める（#296 の indexer 前提）。register / update_home_cell 双方で発行 |
| OQ-M3 | migrate 時に進行中の旧方式 Campaign / CampaignBudget が残った場合 | claim 済みを有効とし残額を Main(V2) へ sweep する一回限り関数。本番前に残存ゼロを確認 |
| OQ-M4 | DonorPass の存続 | 存続（資金フローに影響しない記録系）。`*_with_pass` 変種を新 donate 関数にも用意 |
| OQ-M5 | claim_floor / claim_payout の代理実行 | MVP は sender = owner の pull 型。sponsored transaction による push は将来拡張 |

---

## 付録: タイムライン（README §9 の再掲）

```text
Day 0        DisasterEvent finalize + Campaign 自動作成（同一 tx、Category Pool 自動紐付け）
Day 0+       set_floor_census（後置センサス受理 → floor_ratio 確定 → Category/Main escrow → 床払い開始）
Day 0–30     寄付受付（Campaign 宛て 90/5/5）
Day 0–21     submit_claim 受付
Day 0–30     床払い: verify_claim 済みへ claim_floor で固定額を随時支払い（Campaign 不使用）
Day 30       return_floor_budget（未消化を Category / Main へ按分返還）
             finalize_round (Round 1) → claim_payout 開始（Campaign 残のみ按分）
Day 120...   以後90日ごと再分配（補填なし）、受給者あたり 1 USDC 未満になるまで
終了時       sweep_residual → 端数のみ Main Pool へ（Category へは流さない）
```
