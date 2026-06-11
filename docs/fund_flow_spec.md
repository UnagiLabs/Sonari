# Sonari 資金フロー実装仕様書

本仕様書は、`docs/donation_flow.md`（ユーザー向けガイド）に記載した確定設計を
`contracts/` の Sui Move package へ実装するための技術仕様である。

- 前提仕様: `docs/business_logic.md` §3（Claim 対象条件）・§5（受取先）・§6（duplicate key）はそのまま有効。
- `docs/business_logic.md` §4・§8・§9 には旧設計（50/50 split、Operations Donation、固定支払額）が残っており、本仕様と矛盾する場合は**本仕様を正**とする（§7 に改訂リストを示す）。
- 本仕様は設計文書であり、Move コード・schemas の変更は含まない。

**用語対応**: ユーザー向けガイドの「用途Pool」は本仕様書では **Category Pool**、
「特設募金箱」は **Campaign Pool** と呼ぶ。Campaign Pool は DisasterEvent ごとに1つ自動作成される。
災害向けのプールはこの2層（Category / Campaign）のみとして実装し、これ以外の災害用プール種別は作らない。

---

## 1. 現状実装の調査結果

### 1.1 モジュール一覧（contracts/sources/）

| モジュール | 主な struct | 役割 |
|---|---|---|
| `admin` | `AdminCap`, `PauseState` | genesis 初期化（init で MainPool / OperationsPool / 各 Registry / ClaimIndex を作成）、AdminCap ゲートの管理操作、global / target pause |
| `pools` | `MainPool`, `DesignatedPool`, `OperationsPool`（いずれも shared） | USDC 残高保持。deposit / withdraw は `public(package)`。withdraw は Main / Designated のみ存在（Operations の引き出し関数は無い） |
| `donation` | `DonorRegistry`, `DonorPass`, `DonationRecord` | 寄付受付。General（100% Main）/ Designated（50% Designated + 50% Main）/ Operations（100% Ops）の3種。DonorPass（soulbound、tier 付き）の発行・履歴記録 |
| `program` | `Program`, `Campaign` | generic な Program / Campaign。Campaign は admin が `claim_start_ms` / `claim_end_ms` を指定して手動作成。`budget_opened` フラグ保持 |
| `payout_policy` | `PayoutPolicy`, `CampaignBudget` | Band 1/2/3 = 50/150/300 USDC の固定額ポリシー（shared オブジェクト）。`CampaignBudget` は admin が手動 open し、designated 80% + main backstop 枠を**open 時の残高スナップショット**で算出 |
| `claim` | `ClaimIndex`, `ClaimReceipt`, `ClaimKey` | `claim_disaster_usdc` が申請＝即時支払い（first-come-first-served）。`quote_usdc` で band 固定額・budget 残・pool 残の min を取り、その場で Designated → Main の順に引き落として transfer |
| `disaster_event` | `DisasterRegistry`, `DisasterEvent`, `DisasterCampaignBinding` | enclave 署名済み payload から DisasterEvent を作成。Campaign との紐付けは admin の `bind_disaster_campaign` で**別トランザクション・手動** |
| `affected_cell` | `AffectedCellLeaf`, `ProofStep` | affected cells Merkle proof 検証（sha2-256、leaf prefix 0x00 / internal 0x01） |
| `allowed_residence_cell` | `AllowedResidenceCellRegistry` | 居住セル allowlist の Merkle root 管理（res7 固定） |
| `membership` | `MembershipRegistry`, `MembershipPass`, `MembershipRecord` | Membership SBT。`account_created_at_ms` / `home_cell` / `home_cell_registered_at_ms` / `terms_version` / `signed_statement_hash` 保持。登録は**無料**（fee なし） |
| `identity_registry` | `IdentityRegistry`, `IdentityKey`, `IdentityVerificationRecord` | KYC / World ID の duplicate key binding と本人確認記録（provider_mask、expires_at_ms） |
| `identity_result_v1` | `IdentityVerificationResult` | TEE 署名済み本人確認結果の BCS decode + 検証 |
| `metadata_verifier` | `VerifierRegistry`, `VerifierConfig`, `EnclaveInstance` | Nautilus enclave の PCR / 鍵管理と署名検証（earthquake family = 3 / identity family = 4） |
| `payload` | `Payload` | 地震 oracle payload の BCS decode + finalized 検証（`severity_band`、`affected_cells_root`、`occurred_at_ms`、`hazard_type` 等を含む） |
| `accessor` | — | 外部公開エントリーポイント集約（pause チェック → 各モジュール委譲） |
| `reader` | — | 読み取り専用ヘルパー |

### 1.2 現状の資金フロー（実装ベース）

```text
donate_general_usdc      : 100% → MainPool
donate_designated_usdc   : 50% → DesignatedPool / 50% → MainPool
donate_operations_usdc   : 100% → OperationsPool
claim_disaster_usdc      : 申請と同時に quote_usdc で金額決定し即時支払い
                           （DesignatedPool → MainPool の順、CampaignBudget の枠内）
```

### 1.3 確定設計とのギャップ分析

| # | 項目 | 現状実装 | 確定設計 | ギャップ規模 |
|---|---|---|---|---|
| G1 | Pool 構成 | `MainPool` / `DesignatedPool`（generic、`related_id: Option<ID>`）/ `OperationsPool` の3種 | Category Pool（用途ごと常設）/ Campaign Pool（災害ごと自動作成・期間限定）/ Main / Operations の4種 | 大。`DesignatedPool` + `program::Campaign` + `CampaignBudget` を単一の `Campaign` shared オブジェクトへ統合し、新たに `CategoryPool` を新設する |
| G2 | Category Pool | 存在しない（`DesignatedPool` は災害単位とも用途単位とも決まっていない generic 構造） | 用途（災害種別）ごとに1つ常設。平常時寄付の受け皿 + 同種別 Campaign の第1補填層。MVP は earthquake のみ | 新規 |
| G3 | 寄付分割 | Designated 50/50（Ops への源泉徴収なし）、General 100% Main | Campaign 宛て / Category 宛て: 90/5/5、指定なし: 95/5、Ops は源泉徴収のみ | 大。split ロジック・イベント全面差し替え |
| G4 | Operations Donation | `donate_operations_usdc` が存在（100% Ops 直接寄付） | 廃止。Ops Pool へは源泉徴収分のみが入る | 中。関数削除（旧 package 経由は version ガードで遮断） |
| G5 | ops cap | なし | Campaign 宛て寄付のみ `campaign_ops_cap`（50,000 USDC）。超過分は Main へ。Category 宛て・指定なしの 5% には cap 非適用 | 新規 |
| G6 | Campaign 自動作成 | DisasterEvent 作成・Campaign 作成（admin）・binding（admin）・budget open（admin）が**4つの別操作** | DisasterEvent finalize と同一 tx 内で Campaign Pool を自動作成し、hazard_type から Category Pool と自動で1対1紐付け。admin 裁量なし | 大 |
| G7 | 支払い方式 | 申請＝即時支払い（早い者勝ち。budget / pool 残の min で減額され、後続申請者ほど不利） | finalize_round で按分計算 → claim_payout は保存値を読むだけ。全員同比率 | 大。claim フロー全面再設計（申請と支払いの分離、ラウンド状態） |
| G8 | 支払額計算 | `quote_usdc`: 固定額と残額の min | 充足時 `ratio = min(base, 3.0)`（補填なし）、不足時のみ2層補填で `ratio = min(1.0, …)` | 大 |
| G9 | ラウンド制 | なし（1回限り） | 90日ごとに残高再分配（補填は Round 1 のみ）、終了後 residual sweep | 新規 |
| G10 | Backstop | `CampaignBudget.main_backstop_budget_usdc`（open 時の Main 残高スナップショット × bps）。ratio 1.0 制限なし、Category 層なし | finalize 時に算出する2層ウォーターフォール: Category（可処分 × 1/3）→ Main（`min(可処分 × 20%, designated 受領額 × 100%)`、reserve floor 付き）。ratio 1.0 までに限定 | 大 |
| G11 | パラメータ管理 | `PayoutPolicy` が独立 shared オブジェクト（admin が作成・差し替え可能） | モジュール定数 + Campaign 作成時スナップショット。設定オブジェクト廃止 | 大。`PayoutPolicy` / `CampaignBudget` 廃止 |
| G12 | version ガード | **どの shared オブジェクトにも `version` フィールドなし** | 全 shared オブジェクトに `version`、全 public 関数先頭で assert | 新規（既存オブジェクトはフィールド追加不可のため新 struct で再作成） |
| G13 | 寄付期間 | なし（いつでも寄付可能） | Campaign は作成から30日。終了後の Campaign 宛て寄付は Main へルーティング。Category は常設で期間なし | 新規 |
| G14 | 申請期間 | `claim_start_ms` / `claim_end_ms` を admin が任意指定 | Campaign 作成から21日固定（スナップショット） | 中 |
| G15 | admin 権限 | campaign 作成・budget open・policy 作成・binding すべて admin 裁量 | 「受給者に不利にならない方向」のみ: 寄付期間延長・不正時 pause・不正受給者除外。加えて Category Pool の新設（災害種別追加時、イベント記録） | 大。admin surface の大幅縮小 |
| G16 | DonationSplit イベント | `DesignatedDonationReceived` に main/designated 額のみ。bps 非記録 | 全寄付で分割比率（bps）を毎回イベント記録（自己記述化） | 中 |
| G17 | OpsSpend | OperationsPool の引き出し関数が存在しない | 金額・送金先・reason_code をイベント記録する支出関数 | 新規 |
| G18 | 不正受給者の除外 | なし（pause のみ） | ラウンド単位で除外可能、イベント記録必須 | 新規 |
| G19 | ResidualSweep | なし | ラウンド終了後の端数を Main へ（Category へは流さない）、イベント記録 | 新規 |
| G20 | リアルタイム表示用フィールド | `total_received_usdc` のみ | Campaign: 寄付累計・band 別検証済み申請者数・支払済み総額。Category: 残高・累計流入・補填累計（dapp がオンチェーン読み取りだけで予想受取額を計算可能に） | 中 |

**business_logic.md §10 の既知差分の現状**（参考: 多くは解消済み）

| §10 項目 | 現状 |
|---|---|
| 登録時の fee 前提を外す | ✅ 解消済み（`register_member` は無料） |
| 別受取先の概念を外す | ✅ 解消済み（受取先は SBT owner 固定） |
| Claim 条件へ IdentityRegistry を追加 | ✅ 解消済み（`assert_identity_verified` / `assert_duplicate_key_bound_to_pass`） |
| `account_created_at_ms` の cutoff 判定 | ✅ 解消済み |
| `home_cell_registered_at_ms` の cutoff 判定 | ✅ 解消済み |
| duplicate key registry | ✅ 解消済み（`IdentityRegistry`） |
| 本人確認の段階評価係数を外す | ✅ 解消済み（`quote_usdc` に係数なし） |

つまり §10 の residual はほぼ解消済みであり、残る大きな差分は本仕様が対象とする**資金フロー（G1–G20）**である。

---

## 2. オブジェクト設計

方針:

- 現行の `DesignatedPool` + `program::Campaign` + `CampaignBudget` を**単一の `Campaign` shared オブジェクト**に統合する。資金（`Balance<USDC>`）・スナップショット済みパラメータ・締切・ラウンド状態を1オブジェクトで持つ。
- `CategoryPool` を新設する。用途（災害種別）ごとに1つの常設 shared オブジェクトで、期間・ラウンドの概念は持たない。非災害用途（学生支援等）の追加に耐える generic な設計とする（`category` は u8 のコード値。受給・支払いロジックは持たせない）。
- Sui の package upgrade では struct フィールド追加が不可のため、counter 類・締切・ラウンド状態は**最初から** struct に含める。将来の拡張データ（申請レコード、受取済みフラグ、除外リスト等の可変長データ）は dynamic field で持つ。
- 全 shared オブジェクトに `version: u64` を持たせる。

### 2.1 CategoryPool（shared、用途ごとに1つ・常設）

```move
public struct CategoryPool has key {
    id: UID,
    version: u64,
    category: u8,                      // 用途コード。CATEGORY_EARTHQUAKE = 1（MVP はこれのみ作成）
    balance: Balance<USDC>,

    // リアルタイム表示用（確定設計 I）
    total_received_usdc: u64,          // 累計流入（寄付の Category 取り分）
    total_backstop_paid_usdc: u64,     // Campaign への補填累計

    earmarked_backstop_usdc: u64,      // finalize 済みで未払いの補填予約額
    created_at_ms: u64,
}
```

- 作成は admin の `create_category_pool`（§3.3）。`CategoryRegistry`（または `DisasterRegistry` の dynamic field）で `category → pool_id` の一意性を強制し、同一用途の二重作成を拒否する。
- 期間・ラウンドを持たないため、パラメータのスナップショットも持たない（Category 宛て寄付の split はモジュール定数の現在値を適用し、`DonationSplit` イベントに毎回記録する）。

### 2.2 Campaign（shared、災害ごとに1つ・期間限定）

```move
public struct Campaign has key {
    id: UID,
    version: u64,

    // ---- DisasterEvent / CategoryPool との紐付け（作成時固定） ----
    disaster_event_id: ID,
    event_uid: vector<u8>,              // 32 bytes
    event_revision: u32,
    category: u8,                       // hazard_type から導出
    category_pool_id: ID,               // 自動で1対1紐付け。裁量なし

    // ---- 資金 ----
    balance: Balance<USDC>,

    // ---- リアルタイム表示用（確定設計 I） ----
    total_donated_usdc: u64,            // Campaign 取り分の寄付累計（「今いくら集まっているか」）
    total_paid_usdc: u64,               // 支払済み総額
    // band 別の検証済み申請者数は verified_count_by_band（下記）で公開する

    designated_received_usdc: u64,      // Main 補填上限（designated 100%）の計算基礎
    ops_withheld_usdc: u64,             // この Campaign 起点で Ops へ送った累計（ops cap 判定）

    // ---- 作成時スナップショット（以後不変） ----
    band_target_usdc: vector<u64>,      // [band1, band2, band3] 目標額
    round_cap_multiplier: u64,          // 3
    min_claim_band: u8,                 // 1
    split_campaign_bps: u64,            // 9000
    split_main_bps: u64,                // 500
    split_ops_bps: u64,                 // 500
    campaign_ops_cap_usdc: u64,         // 50,000 USDC
    round_interval_ms: u64,             // 90日
    min_payout_per_recipient_usdc: u64, // ラウンド終了閾値
    category_backstop_divisor: u64,     // 3（Category 可処分 × 1/3）
    backstop_main_share_bps: u64,       // 2000 (20%)
    backstop_designated_match_bps: u64, // 10000 (100%)

    // ---- 締切（作成時に定数から導出。donation_end のみ延長可） ----
    created_at_ms: u64,
    donation_end_ms: u64,               // created + 30日（admin は延長のみ可）
    claim_end_ms: u64,                  // created + 21日（変更不可）

    // ---- 申請状態 ----
    applied_count_by_band: vector<u64>,   // [band1, band2, band3] 申請数
    verified_count_by_band: vector<u64>,  // [band1, band2, band3] 検証済み数（finalize の liability 母数）

    // ---- ラウンド状態 ----
    current_round: u64,                 // 0 = 未 finalize。finalize 毎に +1
    round_finalized_at_ms: u64,         // 直近 finalize 時刻
    round_payout_by_band: vector<u64>,  // 直近 finalize で確定した band 別支払額（claim はこれを読むだけ）
    round_category_draw_usdc: u64,      // 当該ラウンドで Category から引く予定の残枠（Round 1 のみ > 0）
    round_main_draw_usdc: u64,          // 当該ラウンドで Main から引く予定の残枠（Round 1 のみ > 0）
    round_paid_count: u64,              // 当該ラウンドで支払済み件数
    round_eligible_count: u64,          // 当該ラウンド対象者数（finalize 時点の検証済み合計 − 除外）
    closed: bool,                       // residual sweep 済み

    // ---- 運用 ----
    paused: bool,                       // Campaign 単位の一時停止（不正検出時。イベント記録必須）
}
```

dynamic field（`Campaign.id` 配下）:

```move
// 申請レコード: key = pass_lineage_id
public struct ClaimApplication has copy, drop, store {
    band: u8,
    applied_at_ms: u64,
    verified: bool,             // 本人確認まで完了したか
    verified_in_round: u64,     // 検証完了時点の current_round（次の finalize から参加）
    excluded: bool,             // 不正確定による除外
}

// 受取済みフラグ: key = PayoutKey { pass_lineage_id, round }, value = true
public struct PayoutKey has copy, drop, store {
    pass_lineage_id: ID,
    round: u64,
}
```

備考:

- `ClaimReceipt`（受領 NFT）は現行のまま流用するが、`round` フィールドを持つ新 struct `PayoutReceipt` として再定義する（フィールド追加不可のため）。
- 既存 `ClaimIndex` のグローバル duplicate チェックは Campaign 内の `PayoutKey` に置き換わる（campaign 単位 + round 単位での二重受取防止に拡張）。
- 「ラウンド状態は最新ラウンドのみ struct 内に保持し、過去ラウンドの確定値は `RoundFinalized` イベントで追跡する」設計とする（オンチェーン参照が必要になった場合は dynamic field `round → RoundSnapshot` を追加可能）。
- dapp は `total_donated_usdc`・`verified_count_by_band`・`band_target_usdc`・`round_cap_multiplier` のオンチェーン読み取りだけで「今いくら集まっているか」「1人あたりいくら届きそうか」を計算できる（確定設計 I）。

### 2.3 MainPoolV2（shared、プラットフォームに1つ）

```move
public struct MainPoolV2 has key {
    id: UID,
    version: u64,
    balance: Balance<USDC>,
    total_received_usdc: u64,
    total_backstop_paid_usdc: u64,   // backstop 支出累計
    total_swept_in_usdc: u64,        // residual sweep / 期限後寄付 / ops cap 超過の受入累計
    reserve_floor_usdc: u64,         // 補填後も維持すべき絶対額（§8 OQ-1）
    earmarked_backstop_usdc: u64,    // finalize 済みで未払いの backstop 予約額（§8 OQ-8 参照）
    created_at_ms: u64,
}
```

- **運営宛の引き出し関数は存在させない。** `MainPoolV2` から出る経路は (a) finalize 済み Round 1 の backstop 支払い、のみ。
- 既存 `MainPool` は新 package で deprecated とし、残高は migrate 手順（§5）で `MainPoolV2` へ移す。

### 2.4 OperationsPoolV2（shared、プラットフォームに1つ）

```move
public struct OperationsPoolV2 has key {
    id: UID,
    version: u64,
    balance: Balance<USDC>,
    total_received_usdc: u64,
    total_spent_usdc: u64,
    created_at_ms: u64,
}
```

- 入金経路は寄付時の源泉徴収（5%）のみ。`donate_operations_*` 系の直接寄付関数は新 package に**作らない**。
- 支出は `spend_operations`（§3.9）で自由だが、金額・送金先・reason_code を必ずイベント記録する。

### 2.5 所有モデルまとめ

| オブジェクト | 所有 | version | 作成者 |
|---|---|---|---|
| `CategoryPool` | shared | あり | admin（災害種別追加時、イベント記録） |
| `Campaign` | shared | あり | DisasterEvent finalize tx 内で自動作成 |
| `MainPoolV2` / `OperationsPoolV2` | shared | あり | migrate 時に1回 |
| `PayoutReceipt` | owned（claimant へ transfer） | 不要（key only、状態遷移なし） | claim_payout |
| `MembershipPass` / `IdentityRegistry` ほか | 現行のまま | 将来 upgrade 時に同パターン適用を検討 | — |

### 2.6 非災害用途（学生支援等）の扱い

寄付の受け皿としては `CategoryPool`（例: `CATEGORY_STUDENT_SUPPORT = 10`）をそのまま使えるが、
受給資格・支払いロジックが災害 Claim と別物のため、**支払い側は別 Program として将来実装**する。
MVP では非災害 Category Pool を作成しない。`CategoryPool` の struct / 関数には災害固有の
前提（DisasterEvent 参照等）を持ち込まず、用途追加に耐える generic な設計を保つ。

---

## 3. 関数仕様

すべての public 関数は先頭で次を実行する（§5 参照）:

```move
assert!(obj.version == VERSION, EVersionMismatch);   // 引数の全 shared オブジェクト
```

加えて現行どおり `PauseState`（global / target）チェックを accessor 層で行う。

### 3.1 donate_to_campaign（特定災害指定の寄付）

```move
public fun donate_to_campaign(
    pause_state: &PauseState,
    campaign: &mut Campaign,
    main_pool: &mut MainPoolV2,
    ops_pool: &mut OperationsPoolV2,
    coin: Coin<USDC>,
    clock: &Clock,
    ctx: &mut TxContext,
)
```

- 事前条件 / assert:
  - version / pause チェック。`campaign.closed == false`。
  - `coin` 額 > 0（`EZeroDonation`）。
- 処理:
  1. `amount` を 90% / 5% / 5% に分割（bps はスナップショット値を使用。端数は Campaign 取り分に寄せる）。
  2. **ops cap 判定**: `ops_share` のうち `campaign_ops_cap_usdc - ops_withheld_usdc` を超える分は Main へ振り替える。`ops_withheld_usdc` を加算。
  3. **寄付期間判定**: `now >= donation_end_ms` の場合、Campaign 取り分（90%）を Main へルーティングする（5% Main / 5% Ops の扱いは変えない。§8 OQ-6）。
  4. 各 Pool へ deposit。`total_donated_usdc` / `designated_received_usdc` は実際に Campaign に入った額のみ加算。
- イベント: `DonationSplit`（§3.11。target_kind = CAMPAIGN。各実額と適用 bps、`routed_to_main: bool`、ops cap 超過振替額を含む）

### 3.2 donate_to_category（用途指定の寄付）/ donate_general（指定なし）

```move
public fun donate_to_category(
    pause_state: &PauseState,
    category_pool: &mut CategoryPool,
    main_pool: &mut MainPoolV2,
    ops_pool: &mut OperationsPoolV2,
    coin: Coin<USDC>,
    ctx: &mut TxContext,
)
public fun donate_general(
    pause_state: &PauseState,
    main_pool: &mut MainPoolV2,
    ops_pool: &mut OperationsPoolV2,
    coin: Coin<USDC>,
    ctx: &mut TxContext,
)
```

- `donate_to_category`: 90% Category / 5% Main / 5% Ops（モジュール定数の現在値。端数は Category に寄せる）。
  **ops cap は適用しない**（平常時の定率手数料として扱う。確定設計 B）。期間チェックなし（常設）。
- `donate_general`: 95% Main / 5% Ops（端数は Main に寄せる）。ops cap 非適用。
- いずれも額 > 0（`EZeroDonation`）。
- イベント: `DonationSplit`（target_kind = CATEGORY / NONE）

> DonorPass（tier 付き寄付者 SBT）は確定設計の対象外だが、既存機能として維持する。現行同様 `*_with_pass` 変種を用意し、`DonationRecorded` を併発行する。

### 3.3 create_category_pool（admin、災害種別追加時）

```move
public fun create_category_pool(
    _: &AdminCap,
    registry: &mut CategoryRegistry,   // category → pool_id の一意性を管理
    category: u8,
    ctx: &mut TxContext,
): ID
```

- assert: `category` が未登録であること（`ECategoryAlreadyExists`）。
- 処理: `CategoryPool` を作成・share し、registry に `category → pool_id` を登録。
- イベント: `CategoryPoolCreated { pool_id, category, created_at_ms, actor }`（**イベント記録必須**）
- MVP では genesis（migrate）時に earthquake（category = 1）の1つのみ作成する。
  以後の新規作成は災害種別（verifier）追加時に admin が行う。

### 3.4 create_campaign（internal、DisasterEvent finalize と同一 tx）

```move
public(package) fun create_campaign(
    category_registry: &CategoryRegistry,
    category_pool: &CategoryPool,
    disaster_event_id: ID,
    event_uid: vector<u8>,
    event_revision: u32,
    hazard_type: u8,
    severity_band: u8,
    clock: &Clock,
    ctx: &mut TxContext,
): ID
```

- 呼び出し元: `disaster_event::create_from_signed_payload` の末尾（**同一トランザクション内**）。admin が呼べる public エントリーは作らない。
- 事前条件:
  - `severity_band >= MIN_CLAIM_BAND` であること（= band ≥ min_claim_band の affected cell が1つ以上存在することの on-chain 代理条件。payload の `severity_band` が affected cells の最大 band と一致する保証は verifier 側仕様で担保する。§8 OQ-7）。
  - 条件を満たさない場合は Campaign を作らず DisasterEvent のみ作成（abort しない）。
  - **Category Pool との自動1対1紐付け**: `hazard_type` から category（earthquake = 1）を導出し、
    `category_registry` の登録 pool_id と引数 `category_pool` の一致を assert する（`ECategoryPoolMismatch`）。
    ここに裁量を入れない（relayer は正しい CategoryPool を tx 引数として渡すだけで、選択の余地はない）。
- 処理: モジュール定数の現在値を**コピーして** `Campaign` を構築し share。`donation_end_ms = now + DONATION_PERIOD_MS`、`claim_end_ms = now + CLAIM_PERIOD_MS`。
- イベント: `CampaignCreated`（スナップショットした全パラメータ値と category_pool_id を含める＝自己記述化）

> 同一 `event_uid` の revision 更新（re-finalize）時の扱い: 既存 Campaign がある `event_uid` には新 Campaign を作らない（dynamic field `event_uid → campaign_id` を `DisasterRegistry` に置いて判定）。§8 OQ-10。

### 3.5 submit_claim（受給申請、Day 0–21）

```move
public fun submit_claim(
    pause_state: &PauseState,
    campaign: &mut Campaign,
    disaster_event: &DisasterEvent,
    membership_registry: &MembershipRegistry,
    pass: &MembershipPass,
    leaf: AffectedCellLeaf,
    proof: vector<ProofStep>,
    clock: &Clock,
    ctx: &mut TxContext,
)
```

- 事前条件 / assert:
  - version / pause / `campaign.paused == false` / `now < campaign.claim_end_ms`（`EClaimWindowClosed`）。
  - `campaign.disaster_event_id == object::id(disaster_event)`（binding オブジェクト不要。Campaign が直接 ID を保持）。
  - business_logic §3 のうち本人確認以外をすべて検証（現行 `assert_valid_disaster_eligibility` を流用）:
    - leaf の event_uid / revision 一致、Merkle proof、`cell_band >= min_claim_band`（スナップショット値）
    - `membership::assert_current_pass_precheck`（active / owner = sender / registry 整合）
    - `account_created_at_ms < occurred_at_ms`、`home_cell_registered_at_ms < occurred_at_ms`、`home_cell == leaf.h3_index`
  - 同一 `pass_lineage_id` の申請が未登録であること（`EDuplicateApplication`）。
- 処理: `ClaimApplication { band, verified: false, ... }` を dynamic field 登録、`applied_count_by_band[band] += 1`。
- イベント: `ClaimSubmitted { campaign_id, pass_lineage_id, band, applied_at_ms }`
- **本人確認はこの段階では要求しない**（検証遅延者を Day 21 で閉め出さないため）。

### 3.6 verify_claim（申請の本人確認完了、期限なし）

```move
public fun verify_claim(
    pause_state: &PauseState,
    campaign: &mut Campaign,
    identity_registry: &IdentityRegistry,
    membership_registry: &MembershipRegistry,
    pass: &MembershipPass,
    identity_provider: u8,
    duplicate_key_hash: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
)
```

- 事前条件 / assert:
  - 申請が存在し `verified == false`、`excluded == false`。
  - `identity_registry::assert_identity_verified`（owner / provider / 有効期限）
  - `identity_registry::assert_duplicate_key_bound_to_pass`（business_logic §6）
- 処理: `verified = true`、`verified_in_round = campaign.current_round`、`verified_count_by_band[band] += 1`。
- イベント: `ClaimVerified { campaign_id, pass_lineage_id, band, round: current_round }`
- 申請は Day 21 で締切済みのため、verify が増えても**申請者集合は増えない**（検証完了が増えるだけ）。Round N の finalize 後に verified になった申請者は Round N+1 から参加する。

### 3.7 finalize_round（ラウンド確定、誰でも実行可）

```move
public fun finalize_round(
    pause_state: &PauseState,
    campaign: &mut Campaign,
    category_pool: &mut CategoryPool,
    main_pool: &mut MainPoolV2,
    clock: &Clock,
    ctx: &mut TxContext,
)
```

- 事前条件 / assert:
  - version / pause / `campaign.paused == false` / `closed == false`。
  - `object::id(category_pool) == campaign.category_pool_id`（`ECategoryPoolMismatch`）。
  - Round 1: `now >= campaign.created_at_ms + DONATION_PERIOD_MS`（Day 30 以降）。
  - Round 2 以降: `now >= round_finalized_at_ms + round_interval_ms` かつ前ラウンドの支払期間が経過していること。
- 処理（このラウンド内で不変な値を一度だけ計算して保存。確定設計 E / G）:

```text
liability    = Σ_band ( eligible_count[band] × band_target[band] )
               eligible_count[band] = verified_count_by_band[band] − band別除外数
campaign_av  = campaign.balance.value()
draw_category = 0
draw_main     = 0

if campaign_av >= liability:
    # 充足時: 補填は使わない。上振れは Campaign 資金のみ
    ratio = min(campaign_av / liability, round_cap_multiplier)        # min(base, 3.0)
else if current_round == 0:
    # Round 1 のみ2層ウォーターフォールで補填（ratio 1.0 まで）
    shortfall     = liability − campaign_av
    cat_disposable = category.balance − category.earmarked_backstop_usdc
    category_cap   = cat_disposable / category_backstop_divisor        # 可処分 × 1/3
    draw_category  = min(shortfall, category_cap)
    rem            = shortfall − draw_category
    main_disposable = max(main.balance − main.reserve_floor_usdc − main.earmarked_backstop_usdc, 0)
    main_cap       = min( main_disposable × backstop_main_share_bps / 10_000,
                          campaign.designated_received_usdc × backstop_designated_match_bps / 10_000 )
    draw_main      = min(rem, main_cap)
    ratio = min(1.0, (campaign_av + draw_category + draw_main) / liability)
else:
    # Round 2 以降: Campaign 残高の再分配のみ。補填は行わない
    ratio = min(campaign_av / liability, round_cap_multiplier)

band_payout[b] = band_target[b] × ratio          # u128 演算・切り捨て
```

  - `liability == 0`（検証済み受給者ゼロ）の場合: 支払額をゼロとしてラウンドを進める（資金は次ラウンド以降 / sweep へ）。
  - **終了判定**: `(campaign_av + draw_category + draw_main) / total_eligible_count < min_payout_per_recipient_usdc` の場合は finalize せず `sweep_residual` のみ可能な状態とする。
  - 補填採用時は `category.earmarked_backstop_usdc += draw_category`、`main.earmarked_backstop_usdc += draw_main` で**予約**し、他 Campaign の finalize と二重計上しない（§8 OQ-8）。
  - `current_round += 1`、`round_payout_by_band` / `round_category_draw_usdc` / `round_main_draw_usdc` / `round_eligible_count` を保存、`round_paid_count = 0`。
- イベント: `RoundFinalized { campaign_id, round, liability, campaign_available, category_draw, main_draw, band_payout: vector<u64>, eligible_count, finalized_at_ms }`、補填 > 0 のとき層ごとに `BackstopDraw { source: CATEGORY | MAIN, ... }`

### 3.8 claim_payout（受給者ごとの受取）

```move
public fun claim_payout(
    pause_state: &PauseState,
    campaign: &mut Campaign,
    category_pool: &mut CategoryPool,
    main_pool: &mut MainPoolV2,
    membership_registry: &MembershipRegistry,
    pass: &MembershipPass,
    ctx: &mut TxContext,
)
```

- 事前条件 / assert:
  - version / pause / `campaign.paused == false` / `current_round >= 1`。
  - `object::id(category_pool) == campaign.category_pool_id`。
  - `membership::assert_current_pass_precheck`（sender = owner、active）。
  - 申請 `ClaimApplication` が存在し `verified == true` / `excluded == false`。
  - `verified_in_round < current_round` であること（finalize 前に検証済みだった者のみ。`ERoundNotEligible`）。
  - `PayoutKey { pass_lineage_id, round: current_round }` が未登録（`EDuplicatePayout`）。
- 処理:
  1. `amount = campaign.round_payout_by_band[band]` を**読むだけ**。再計算しない。生のプール残高から金額を導出することは禁止。
  2. `PayoutKey` を登録、`round_paid_count += 1`、`total_paid_usdc += amount`。
  3. **Campaign → Category → Main の順に引き落とす**: まず Campaign 残高から、足りない分を Category から（`round_category_draw_usdc` の残枠内。引いた分だけ Category の earmark と残枠を減算し `total_backstop_paid_usdc` を加算）、さらに足りない分を Main から（`round_main_draw_usdc` の残枠内。同様に減算・加算）。
  4. `transfer::public_transfer(coin, pass.owner)` — 受取先は **Membership SBT owner の Sui address**（business_logic §5）。
  5. `PayoutReceipt`（round 付き）を発行。
- イベント: `PayoutClaimed { campaign_id, round, pass_lineage_id, band, amount_usdc, campaign_paid_usdc, category_paid_usdc, main_paid_usdc, recipient }`

### 3.9 spend_operations（運営費支出）

```move
public fun spend_operations(
    _: &AdminCap,
    ops_pool: &mut OperationsPoolV2,
    amount: u64,
    recipient: address,
    reason_code: u8,
    ctx: &mut TxContext,
)
```

- assert: version、`amount > 0`、残高 ≥ amount。
- イベント: `OpsSpend { ops_pool_id, amount, recipient, reason_code, actor }`
- reason_code（初期セット案）: `1 = infra`, `2 = audit`, `3 = oracle_ops`, `4 = support`, `255 = other`。
- **Main / Category / Campaign Pool から運営宛に引き出す関数はどこにも存在させない。**

### 3.10 sweep_residual（最終スイープ）/ exclude_recipient / extend_donation_period / pause

```move
public fun sweep_residual(
    pause_state: &PauseState,
    campaign: &mut Campaign,
    category_pool: &mut CategoryPool,
    main_pool: &mut MainPoolV2,
    clock: &Clock,
    ctx: &mut TxContext,
)
```

- 事前条件: 終了判定（§3.7）を満たす、または `liability == 0` のままラウンド間隔が経過。`closed == false`。
- 処理: Campaign 残高全額を **Main へ**移し `closed = true`（**Category Pool へは流さない**。確定設計 F）。
  未消化の earmark（Category / Main）を解放。
- イベント: `ResidualSweep { campaign_id, amount, final_round }`
- 実行者: 誰でも可（permissionless。終了条件は決定的なため）。

```move
public fun exclude_recipient(
    _: &AdminCap,
    campaign: &mut Campaign,
    pass_lineage_id: ID,
    reason_code: u8,
    ctx: &mut TxContext,
)
```

- 処理: `application.excluded = true`、`verified_count_by_band[band] -= 1`（verified だった場合）。**次の finalize から**除外が反映される。確定済みラウンドの保存値は変更しない（§8 OQ-9）。
- イベント: `RecipientExcluded { campaign_id, pass_lineage_id, reason_code, round: current_round }`（**イベント記録必須**）

```move
public fun extend_donation_period(
    _: &AdminCap, campaign: &mut Campaign, new_donation_end_ms: u64, ctx: &mut TxContext,
)
```

- assert: `new_donation_end_ms > campaign.donation_end_ms`（**延長のみ。短縮不可** `EDonationPeriodShortenNotAllowed`）。
- イベント: `DonationPeriodExtended { campaign_id, old_end_ms, new_end_ms }`

Campaign の一時停止は既存の `PauseState`（target = campaign_id）を流用しつつ、`campaign.paused` フラグも対で設け、`pause_campaign / unpause_campaign`（AdminCap、`Paused` / `Unpaused` イベント必須）を提供する。

**admin に許す操作は以上ですべて**（Category Pool 新設・寄付期間延長・pause / unpause・不正受給者除外・ops 支出・verifier / PCR 管理・migrate）。金額・split・対象条件を狭める方向の操作、Campaign の任意作成、policy の差し替えは実装しない。

### 3.11 イベント定義（最低限）

```move
public struct CampaignCreated has copy, drop {
    campaign_id: ID, disaster_event_id: ID, event_uid: vector<u8>, event_revision: u32,
    category: u8, category_pool_id: ID,
    band_target_usdc: vector<u64>, round_cap_multiplier: u64, min_claim_band: u8,
    split_bps: vector<u64>,              // [campaign, main, ops]
    campaign_ops_cap_usdc: u64, donation_end_ms: u64, claim_end_ms: u64,
    round_interval_ms: u64,
    category_backstop_divisor: u64, backstop_main_share_bps: u64,
    backstop_designated_match_bps: u64,
    created_at_ms: u64,
}
public struct CategoryPoolCreated has copy, drop {
    pool_id: ID, category: u8, created_at_ms: u64, actor: address,
}
public struct DonationSplit has copy, drop {
    target_kind: u8,                     // 1 = CAMPAIGN / 2 = CATEGORY / 3 = NONE
    campaign_id: Option<ID>,
    category_pool_id: Option<ID>,
    amount: u64,
    target_amount: u64, main_amount: u64, ops_amount: u64,
    applied_bps: vector<u64>,            // 自己記述化: 毎回記録
    ops_cap_overflow_to_main: u64,       // ops cap 超過で Main へ回った額（CAMPAIGN のみ）
    routed_to_main: bool,                // 寄付期間終了後ルーティングが発動したか（CAMPAIGN のみ）
    donor: address, donated_at_ms: u64,
}
public struct RoundFinalized has copy, drop {
    campaign_id: ID, round: u64, liability_usdc: u64, campaign_available_usdc: u64,
    category_draw_usdc: u64, main_draw_usdc: u64, band_payout_usdc: vector<u64>,
    eligible_count: u64, finalized_at_ms: u64, actor: address,
}
public struct PayoutClaimed has copy, drop {
    campaign_id: ID, round: u64, pass_lineage_id: ID, band: u8,
    amount_usdc: u64, campaign_paid_usdc: u64, category_paid_usdc: u64, main_paid_usdc: u64,
    recipient: address, claimed_at_ms: u64,
}
public struct BackstopDraw has copy, drop {
    campaign_id: ID, round: u64,
    source: u8,                          // 1 = CATEGORY / 2 = MAIN
    amount_usdc: u64,
    source_disposable_usdc: u64,         // 算定時点の補填元可処分残高
    designated_received_usdc: u64,       // MAIN のとき: designated 上限の計算基礎
}
public struct OpsSpend has copy, drop {
    ops_pool_id: ID, amount_usdc: u64, recipient: address, reason_code: u8, actor: address,
}
public struct RecipientExcluded has copy, drop {
    campaign_id: ID, pass_lineage_id: ID, reason_code: u8, round: u64, actor: address,
}
public struct ResidualSweep has copy, drop {
    campaign_id: ID, amount_usdc: u64, final_round: u64, swept_at_ms: u64,
}
```

補助イベント: `ClaimSubmitted` / `ClaimVerified` / `DonationPeriodExtended` / 既存 `Paused` / `Unpaused` / `GenesisObjectCreated`。

---

## 4. 定数表

USDC は 6 decimals（1 USDC = 1_000_000 units）。すべて**モジュール定数**として持ち、Campaign 作成時にスナップショットする。変更は package upgrade で行い、**次に作成される Campaign から**適用される（Category 宛て・指定なし寄付の split は常設 Pool のため、upgrade 後の寄付から新定数を適用し `DonationSplit` で毎回記録する）。

| 定数名 | 型 | 初期値 | 意味 | 変更方法 |
|---|---|---|---|---|
| `VERSION` | `u64` | `1` | shared オブジェクトの現行バージョン | upgrade（migrate と対） |
| `CATEGORY_EARTHQUAKE` | `u8` | `1` | 地震カテゴリのコード値 | upgrade（追加のみ） |
| `BAND_1_TARGET_USDC` | `u64` | `50_000_000` | Band 1 目標額 50 USDC | upgrade |
| `BAND_2_TARGET_USDC` | `u64` | `150_000_000` | Band 2 目標額 150 USDC | upgrade |
| `BAND_3_TARGET_USDC` | `u64` | `300_000_000` | Band 3 目標額 300 USDC | upgrade |
| `ROUND_CAP_MULTIPLIER` | `u64` | `3` | ラウンド上限 = 目標額 × 3 | upgrade |
| `MIN_CLAIM_BAND` | `u8` | `1` | Claim / Campaign 作成の最低 band | upgrade |
| `DIRECTED_SPLIT_TARGET_BPS` | `u64` | `9_000` | Campaign / Category 宛て寄付 → 指定先 90% | upgrade |
| `DIRECTED_SPLIT_MAIN_BPS` | `u64` | `500` | Campaign / Category 宛て寄付 → Main 5% | upgrade |
| `DIRECTED_SPLIT_OPS_BPS` | `u64` | `500` | Campaign / Category 宛て寄付 → Ops 5% | upgrade |
| `GENERAL_SPLIT_MAIN_BPS` | `u64` | `9_500` | 指定なし寄付 → Main 95% | upgrade |
| `GENERAL_SPLIT_OPS_BPS` | `u64` | `500` | 指定なし寄付 → Ops 5% | upgrade |
| `CAMPAIGN_OPS_CAP_USDC` | `u64` | `50_000_000_000` | Campaign 宛て寄付の ops 受取上限 50,000 USDC（Campaign 単位。Category / 指定なしには非適用） | upgrade |
| `DONATION_PERIOD_MS` | `u64` | `2_592_000_000` | Campaign 寄付受付 30日 | upgrade（個別 Campaign は admin 延長のみ可） |
| `CLAIM_PERIOD_MS` | `u64` | `1_814_400_000` | 申請受付 21日 | upgrade |
| `ROUND_INTERVAL_MS` | `u64` | `7_776_000_000` | ラウンド間隔 90日 | upgrade |
| `MIN_PAYOUT_PER_RECIPIENT_USDC` | `u64` | `1_000_000` | ラウンド終了閾値: 受給者あたり 1 USDC 未満（提案値、OQ-3） | upgrade |
| `CATEGORY_BACKSTOP_DIVISOR` | `u64` | `3` | 第1層補填上限: Category 可処分残高 × 1/3（1イベントあたり） | upgrade |
| `BACKSTOP_MAIN_SHARE_BPS` | `u64` | `2_000` | 第2層補填上限: Main 可処分 × 20% | upgrade |
| `BACKSTOP_DESIGNATED_MATCH_BPS` | `u64` | `10_000` | 第2層補填上限: designated 受領額 × 100% | upgrade |
| `MAIN_RESERVE_FLOOR_USDC` | `u64` | `100_000_000_000`（提案: 100,000 USDC、OQ-1） | 補填後も Main に残す絶対額 | upgrade + migrate（MainPoolV2 フィールドに保持） |
| `BPS_DENOMINATOR` | `u64` | `10_000` | bps 計算分母 | 不変 |

按分計算は `(target as u128) * (available as u128) / (liability as u128)` の u128 演算・切り捨てで行い、bps 化による精度劣化を避ける。

---

## 5. アップグレード方針

### 5.1 version ガードの実装パターン

```move
// 各モジュール共通
const VERSION: u64 = 1;
const EVersionMismatch: u64 = ...;

// 全 public 関数の先頭（引数に取る全 shared オブジェクトに対して）
fun assert_version(campaign: &Campaign) {
    assert!(campaign.version == VERSION, EVersionMismatch);
}
```

- 旧 package のコードはオンチェーンに残り続けるため、upgrade 後に旧エントリーを叩かれても `version` 不一致で abort させる。これが**旧ロジック経由の資金移動を無効化する唯一の確実な手段**であり、全 public 関数で必須とする。
- migrate は AdminCap ゲートで提供する:

```move
public fun migrate_campaign(_: &AdminCap, campaign: &mut Campaign) {
    assert!(campaign.version < VERSION, ENotUpgrade);
    campaign.version = VERSION;
    // 必要ならここで dynamic field の初期化等を行う
}
```

### 5.2 struct 拡張の方針

- Sui の package upgrade では **struct フィールドの追加・削除・変更が不可**。このため Campaign / CategoryPool struct には counter 類・締切・ラウンド状態（§2）を最初から含めた。
- 将来の拡張（例: Matching Pledge の状態、チャレンジ期間の記録、ラウンドスナップショットの常設化）は **dynamic field で行う**ことを前提とする。新フィールドが必要なケースは「新 struct + migrate（資金・状態の引っ越し）」になるため、設計段階で避ける。

### 5.3 migrate 手順（現行 → 本仕様 V2）

1. 新 package を upgrade publish（旧 struct は残るが新規エントリーは V2 のみ）。
2. `MainPoolV2` / `OperationsPoolV2` / `CategoryRegistry` / earthquake `CategoryPool` を genesis 関数で作成（`GenesisObjectCreated` / `CategoryPoolCreated` 発行）。
3. AdminCap ゲートの一回限り関数で旧 `MainPool` / `OperationsPool` / 各 `DesignatedPool` の残高を V2 へ移送（移送イベント記録）。旧 pool への入金経路は旧関数のみで、これらは新 package で削除（旧 struct に version が無いため、**旧入金関数を新 package で abort 実装に差し替える**ことで遮断する）。
4. 進行中 Campaign がある場合の扱いは §8 OQ-11。
5. dapp / relayer / scripts の参照オブジェクト ID を更新（`Published.toml` 由来の導出を維持）。

### 5.4 定数変更の運用

- 定数変更 = package upgrade。進行中の Campaign はスナップショット済みのため影響を受けない。
- 新定数は次に作成される Campaign から適用される。`CampaignCreated` イベントが適用値を自己記述するため、インデクサは定数のバージョン管理を必要としない。

---

## 6. フェーズ分け

### 6.1 MVP（本仕様の実装対象）

- `MainPoolV2` / `OperationsPoolV2` / `CategoryPool`（earthquake のみ）/ `Campaign`（統合オブジェクト）と version ガード
- `donate_to_campaign`（90/5/5、ops cap、期限後 Main ルーティング）/ `donate_to_category`（90/5/5、cap 非適用）/ `donate_general`（95/5）/ `DonationSplit` イベント
- DisasterEvent finalize と同一 tx での Campaign 自動作成（band 条件 + Category Pool 自動紐付け）
- `submit_claim` / `verify_claim`（申請と本人確認の分離）
- `finalize_round` / `claim_payout`（按分計算と支払いの分離、Round 1 + 90日ごとの再分配）
- 2層 Backstop（Round 1 のみ。Category 1/3 → Main 20% / designated 100%、reserve floor、earmark）
- `sweep_residual`（Main へのみ）/ `exclude_recipient` / `extend_donation_period` / `spend_operations` / `create_category_pool`
- リアルタイム表示用フィールド（Campaign: 寄付累計・band 別検証済み数・支払済み総額 / Category: 残高・累計流入・補填累計）
- 旧 `donate_operations_*` / `PayoutPolicy` / `CampaignBudget` / 即時支払い `claim_disaster_usdc` の廃止と migrate
- 対応通貨は USDC のみ

### 6.2 将来拡張（MVP に含めない）

| 項目 | 概要 | 備考 |
|---|---|---|
| Category Pool の種別追加 | 洪水・台風など。verifier 追加と対で admin が `create_category_pool` | struct / 関数は MVP から generic |
| 非災害 Program（学生支援等） | 寄付の受け皿は Category Pool 基盤に載せ、受給・支払いロジックは別 Program として実装 | MVP では Category Pool を作成しない |
| Matching Pledge | スポンサーが「集まった寄付と同額を上乗せ」を事前コミット | Campaign の dynamic field + 専用エスクローで追加可能 |
| チャレンジ期間 | finalize 結果に対する異議申し立てウィンドウ | `finalize_round` と支払い開始の間に遅延を挟む設計余地を残す |
| 少額即時給付 | finalize を待たない緊急少額 payout（例: Band 3 のみ 10 USDC 即時） | ラウンド按分と二重取りしない控除設計が必要 |
| ラウンド自動実行 | keeper / scheduler への実行インセンティブ（gas 補助 bounty） | MVP は permissionless + 運営の off-chain cron で代替（OQ-4） |
| 複数通貨対応 | USDC 以外のステーブル | pools の generic 化 |
| 地域係数 | band × 地域係数 | 確定設計で「地域係数なし」のため将来検討のみ |
| grace period | 居住セル変更の cutoff 厳格化（business_logic §3 後段） | 既存の将来項目 |

---

## 7. business_logic.md 改訂リスト（書き換えは行わない。リストのみ）

### §4（支払額の考え方）

| 現記述 | 改訂案 |
|---|---|
| 「基本の一時支援額は次を目安にする。Band 1: $50 / Band 2: $150 / Band 3: $300」 | 「Band 目標額（保証額ではない）: Band 1 = 50 / Band 2 = 150 / Band 3 = 300 USDC（比率 1:3:6、地域係数なし）。実際の支払額は finalize_round で確定する: 充足時は `ratio = min(残高/必要額, 3.0)`、不足時は Category → Main の2層補填で `ratio = min(1.0, …)`」へ書き換え |
| 「Pool が不足する場合は、CampaignBudget の中で支払う。」 | 削除。「不足時は同種別 Category Pool（可処分 × 1/3）→ Main Pool（可処分 × 20% かつ designated 受領額 × 100%、reserve floor 維持）の順で ratio 1.0 まで補填する（Round 1 のみ）」へ置き換え（CampaignBudget は廃止） |
| 「将来、対象者全体を見た按分を追加できる。」 | 削除（按分は将来案ではなく確定設計のコア。締切後一括計算・早い者勝ちなしを明記） |
| （追記） | ラウンド制（Day 30 に Round 1、以後90日ごと再分配。補填は Round 1 のみ。残額の最終 sweep は Main へ）を新設の節として追加 |

### §8（資金プール）

| 現記述 | 改訂案 |
|---|---|
| Pool 表「Main / Designated Relief / Operations」 | 4 Pool 構成へ差し替え: 「Category Pool（用途ごと常設・平常時寄付の受け皿・第1補填層。MVP は earthquake のみ）/ Campaign Pool（災害ごと自動作成・期間限定）/ Main Pool（指定なし寄付の受け皿・最終補填層・sweep 受け皿）/ Operations Pool（源泉徴収のみ）」 |
| 「General Donation -> 100% Main Pool」 | 「指定なし寄付: 95% Main / 5% Ops」へ |
| 「Designated Donation -> 50% Designated / 50% Main」 | 「特定災害指定（Campaign 宛て）: 90% Campaign / 5% Main / 5% Ops。用途指定（Category 宛て）: 90% Category / 5% Main / 5% Ops」へ |
| 「Operations Donation -> 100% Operations Pool」 | 削除（Operations Donation 廃止。Ops Pool の収入は源泉徴収のみ） |
| （追記） | campaign_ops_cap（50,000 USDC、Campaign 宛てのみ、超過分は Main へ）、Main / Category / Campaign から運営宛の引き出し関数は存在しないこと、Ops 支出はイベント記録必須であること、Campaign の寄付期間（30日）終了後の寄付は Main へルーティングされることを追加 |

### §9（災害支払いの流れ）

| 現記述 | 改訂案 |
|---|---|
| 「Sponsor donates to Earthquake Pool -> … -> Earthquake Pool pays first -> Main Pool covers allowed shortage -> Relief Receipt is issued」の即時支払いフロー | ラウンド制フローへ全面書き換え: `災害 finalize（Campaign 自動作成・Category Pool 自動紐付け・同一 tx）→ 寄付30日 / 申請21日 → Day 30 Round 1 finalize（按分確定・2層補填込み一括計算）→ claim_payout（保存値の読み出しのみ・Campaign → Category → Main の順に引き落とし）→ 90日ごと再分配（補填なし）→ 終了後 residual sweep（Main へ）` |
| （追記） | finalize と claim の分離（生のプール残高から金額を導出しない）、二重受取防止はラウンド単位、検証遅延者は検証完了後のラウンドから参加、admin の関与は Category Pool 新設・延長・pause・除外のみ、を明記 |

### §10（現在の Move 実装との差分）

- 解消済み項目（fee、別受取先、IdentityRegistry、cutoff 2種、duplicate key、段階評価係数）を「解消済み」へ更新し、残課題を本仕様のギャップ（G1–G20）への参照に差し替える。

---

## 8. Open Questions（推奨案付き）

| # | 論点 | 推奨案 |
|---|---|---|
| OQ-1 | **reserve floor の絶対額**: Main Pool に最低いくら残すか | 初期値 **100,000 USDC**（`MAIN_RESERVE_FLOOR_USDC`）。根拠: 中規模災害1件（受給者 1,000人 × Band 2 平均 150 USDC ≒ 150k）の概ね 2/3 を常時下支えできる水準。`MainPoolV2` のフィールドとして保持し、migrate で調整可能とする |
| OQ-2 | **Category 補填上限 1/3 の妥当性**: 1イベントあたり Category 可処分 × 1/3 で十分か / 過大か | `1/3` を採用（`CATEGORY_BACKSTOP_DIVISOR = 3`）。根拠: 同種別災害が短期間に連発しても最低3イベント分の補填余力を残せる。連発時は後発ほど可処分が減って自然に補填額が逓減する性質も併せ持つ。係数は upgrade で調整可能なため、初期は保守的な 1/3 で開始し運用データで見直す |
| OQ-3 | **ラウンド終了閾値**: 「受給者あたり 1 USDC 未満」の確定 | `MIN_PAYOUT_PER_RECIPIENT_USDC = 1 USDC` を採用。加えて絶対額ガード `campaign_balance < 10 USDC` でも終了可とする（受給者ゼロで残高僅少のケースを拾う） |
| OQ-4 | **finalize の実行者・インセンティブ**: 誰が Day 30 / 90日ごとに `finalize_round` を呼ぶか | permissionless（誰でも実行可、計算は決定的）+ 運営の off-chain scheduler（既存 AWS runner 系に cron 追加）を MVP とする。gas bounty（実行者へ Campaign から固定額）は将来拡張 |
| OQ-5 | **検証遅延者のラウンド参加の状態遷移**: `verified_in_round` の比較セマンティクス | `verify_claim` 時点の `current_round` を記録し、`claim_payout` は `verified_in_round < current_round` を要求する（= 自分が verified になった後に finalize されたラウンドのみ受取可）。finalize は実行時点の `verified_count_by_band` を母数にするため、保存値と整合する |
| OQ-6 | **寄付期間終了後の Campaign 宛て寄付の split**: 「Main へルーティング」が 90% 部分のみか全体か | Campaign 取り分 90% を Main へ振り替え、5% Main / 5% Ops（cap 内）は通常どおりとする（実質 95/5 で指定なし寄付と同等になり一貫する）。`DonationSplit.routed_to_main = true` で記録。代替案として「Category Pool へ振り替え」も考えられるが、確定設計 B の明文（Main へルーティング）に従う |
| OQ-7 | **Campaign 作成条件の on-chain 判定**: 「band ≥ min_claim_band の affected cell が1つ以上」を payload の `severity_band` で代理してよいか | payload スキーマ上 `severity_band` が affected cells の最大 band であることを verifier 仕様（schemas/）で明文化し、`severity_band >= MIN_CLAIM_BAND` の判定を採用。将来 band 別セル数を payload に追加する場合は oracle_version を上げる |
| OQ-8 | **補填の競合**: finalize 後〜支払い完了までに Category / Main 残高が他 Campaign の finalize / 支払いに食われるリスク | `earmarked_backstop_usdc`（Category / Main 両方）による予約方式を採用（finalize 時に加算、支払い時に減算、sweep 時に未消化分を解放）。disposable 計算は earmark 控除後で行い、二重引当てを防ぐ。代替案（finalize 時に Coin を Campaign へ物理移動）は「送金時に Campaign → Category → Main の順で引き落とす」という確定設計 G と整合しないため不採用 |
| OQ-9 | **除外の遡及範囲**: 確定済みラウンドの band_payout は除外後も再計算しない（他受給者の受取額が途中で変わらない）でよいか | 再計算しない。除外者の未受取分はそのまま Campaign に残り、次ラウンドで全員に再分配される。確定値の不変性（早い者勝ち排除の根拠）を優先 |
| OQ-10 | **DisasterEvent の revision 更新（re-finalize）時の Campaign**: 同一 event_uid の新 revision で Campaign を作り直すか | 作り直さない（最初の finalize の Campaign を維持）。affected cells root が変わった場合の申請検証は「Campaign が紐づく revision の root」を使い続ける。revision 更新で対象が広がるケースの救済は将来課題として別 issue 化を推奨 |
| OQ-11 | **migrate 時に進行中の旧方式 Campaign / CampaignBudget があった場合** | 旧方式の Campaign は claim 済み分をそのまま有効とし、残額を新 Campaign へ引き継がず Main(V2) へ sweep する一回限りの migrate 関数を用意（イベント記録）。dev / testnet 段階のため実害は限定的だが、本番 migrate 前に残存 Campaign ゼロを運用手順で確認する |
| OQ-12 | **DonorPass の存続**: 確定設計に DonorPass / tier の言及がない | 既存機能として存続（資金フローに影響しない記録系のため）。`*_with_pass` 変種を新 donate 関数にも用意する |
| OQ-13 | **claim_payout の代理実行**: 受給者以外（運営）が gas を負担して受給者へ push する払い出しを許すか | MVP では sender = owner 限定（現行と同じ pull 型）。sponsored transaction（Sui の gas sponsor）で UX 改善できるため、push 型関数の追加は将来拡張 |
| OQ-14 | **「1人あたりいくら届きそうか」の表示定義**: 補填込みで出すか、Campaign 残高のみで出すか | dapp はオンチェーン読み取り値から `予想 ratio = min(max(total/liability, 1.0 ※補填想定), 3.0)` のような楽観値と、`Campaign 残高のみ` の保守値の両方を計算できる。表示仕様は dapp 側で決定し、contract は §2.2 の読み取りフィールド提供までを責務とする |

---

## 付録: タイムライン（確定設計 F の再掲）

```text
Day 0        DisasterEvent finalize + Campaign 自動作成（同一 tx、Category Pool 自動紐付け）
Day 0–30     寄付受付（Campaign 宛て 90/5/5）
Day 0–21     submit_claim 受付
Day 21–30    検証処理（verify_claim）の完了猶予
Day 30       finalize_round (Round 1) → claim_payout 開始
             ※ 不足時はここでのみ Category → Main の2層補填（ratio 1.0 まで）
Day 120      finalize_round (Round 2): Campaign 残高のみを同じ検証済み集合へ再分配（補填なし）
Day 210...   以後90日ごと、受給者あたり 1 USDC 未満になるまで繰り返し
終了時       sweep_residual → 端数のみ Main Pool へ（Category へは流さない。イベント記録）
```
