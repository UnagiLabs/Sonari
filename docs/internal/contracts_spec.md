# Sonari Sui Contracts 設計仕様書

本書は Sonari Sui Move package（`contracts/`）の**技術的設計の正（あるべき姿）**である。
ここに記述する内容は target の完成状態であり、実装はこの仕様に合わせる。

- 資金フロー（Pool 構成・寄付分割・**床払い + 本払いの2段階支払い**・後置センサスによる
  floor_ratio 確定）は本書を正とする。
- 本人確認・災害イベント検証・Merkle proof などの認証/検証まわりは、
  現行実装をそのまま仕様として記述する（変更しない）。
- 寄付者・受給者向けの平易な説明は [docs/donation_flow.md](../donation_flow.md) を参照する。
- **対象地域の災害前登録メンバー数の off-chain 集計（後置センサス）** は本書の §床払い と
  GitHub issue **#296** を正とする。コントラクトは署名済みセンサス結果を検証・消費するだけで、
  集計自体は行わない。

**用語対応**: ユーザー向けガイドの「用途Pool」は本書では **Category Pool**、
「特設募金箱」は **Campaign Pool（`Campaign`）**、「最低ラインの支援金」は **床払い（Floor / Round 0）**、
「寄付の分配」は **本払い（Round 1 以降）** と呼ぶ。

## 1. Overview

Sonari contracts は、寄付 Pool、災害 Campaign、Membership SBT、
本人確認 registry、DisasterEvent、Claim / Payout、Receipt を管理する。
災害支援は最初のユースケースであり、汎用の支援基盤として設計する。

Sonari は保険ではない。支払いを保証しない。
DonorPass や Membership SBT は支払い保証を与えない。

受給の基本ルール:

- 災害前に作成され、災害前に居住セルを登録した active な Membership SBT の owner だけが申請できる。
- 初回資格確立と床払いには、KYC または World ID で本人確認済みであることを要求する。
- **支払額は早い者勝ちにならない**。床払いは作成直後にセンサスで1人あたり額を固定し、
  本払いは募集締切後にラウンド単位で按分確定して全員が同じ比率で受け取る。

支払いは2段階で届く:

| 段階 | 名称 | 時期 | 資金源 | 金額の決まり方 |
| --- | --- | --- | --- | --- |
| 即時 | **床払い（Floor / Round 0）** | `return_floor_budget` 実行まで、本人確認完了しだい随時 | **Category Pool + Main Pool**（Campaign は使わない） | 後置センサスで作成直後に固定。タイミング非依存 |
| 締切後 | **本払い（Round 1 以降）** | Day 30 に Round 1、以後90日ごと | **Campaign Pool のみ**（Category / Main は使わない） | ラウンド確定（claim 内 lazy finalize）で按分。全員同比率 |

## 2. 設計原則

1. **Trust boundary**: Move contract は dapp、worker、relayer、storage を信頼しない。
   Nautilus enclave 署名済み payload（災害・本人確認・**センサス**）、on-chain state、
   SBT owner だけを使って検証する。
2. **No raw PII**: raw KYC data、World ID proof detail、credential 原文、本人確認書類画像、
   住所、電話、GPS 履歴をオンチェーンに保存しない。
3. **作成時スナップショット**: パラメータはモジュール定数として持ち、Campaign 作成時に
   オブジェクトへコピーして固定する。進行中の Campaign のルールは二度と変わらない。
4. **支払額計算と受取の分離**: 本払い額はラウンド確定（finalize）で一度だけ計算して保存する。
   finalize は独立入口ではなく `claim` の中で時間境界を跨いだ初回呼び出し時に遅延実行
   （lazy finalize）するが、確定後はそのラウンド内で不変である。床払い額はセンサス確定時に固定する。
   受取（`claim`）は保存値を読むだけで、生のプール残高から金額を導出しない。
5. **オンチェーンは集計しない**: 対象地域の登録者数など「全件 / 全セルの集計」は
   Move では不可能（DF 列挙不可・affected cells は root のみ・最大100万セル）。
   署名済みオフチェーン結果（後置センサス、#296）を検証・消費する。
6. **admin 最小権限**: admin に許す操作は「受給者に不利にならない方向」のみ
   （Category Pool の新設、寄付期間の延長、不正検出時の一時停止、不正受給者の除外、
   Ops Pool からの支出）。金額・split・対象条件を狭める方向の操作、
   Campaign の任意作成、floor_ratio の手動設定は実装しない。
7. **version ガード**: 全 shared オブジェクトに `version` フィールドを持たせ、
   全 public 関数の先頭で現行バージョン一致を assert する。
8. **自己記述イベント**: 資金が動くたびに、適用された比率・金額・理由をイベントへ記録する。
9. **リアルタイム可視化**: 「今いくら集まっているか」「1人あたりいくら届きそうか」を
   dapp がオンチェーン読み取りだけで計算できるよう、Campaign / Category Pool に
   読み取り可能なカウンタを持たせる。

## 3. モジュール構成

| モジュール | 主な struct | 役割 |
| --- | --- | --- |
| `admin` | `AdminCap`, `PauseState` | genesis 初期化、AdminCap ゲートの管理操作、global / target pause |
| `pools` | `MainPool`, `OperationsPool` | プラットフォーム共通 Pool（version 付き shared） |
| `category_pool` | `CategoryPool`, `CategoryRegistry` | 用途（災害種別）ごとの常設 Pool。平常時寄付の受け皿 + 床払いの第1資金源 |
| `campaign` | `Campaign`, `ClaimApplication`, `PayoutKey` | 災害ごとの募金箱＋床予約 escrow＋申請＋ラウンド状態の統合オブジェクト |
| `donation` | `DonorRegistry`, `DonorPass`, `DonationRecord` | 寄付受付と分割、寄付者 SBT（tier 付き、記録のみ） |
| `floor` | （`campaign` 内に統合可） | センサス受理・floor_ratio 確定・床予算 escrow・床払い（`claim` 経由）・床予算返還 |
| `payout` | `ClaimReceipt`（床/本払い共通、`kind` で区別） | ラウンド lazy finalize・本払い按分計算・本払い（`claim` 経由）・sweep |
| `disaster_event` | `DisasterRegistry`, `DisasterEvent` | enclave 署名済み payload からの DisasterEvent 作成と Campaign 自動作成の起点 |
| `payload` | `Payload` | 地震 oracle payload の BCS decode と finalized 検証 |
| `census_result` | `FloorCensusResult` | 後置センサスの署名済み band 別カウント payload の BCS decode と検証（#296） |
| `affected_cell` | `AffectedCellLeaf`, `ProofStep` | affected cells の Merkle proof 検証 |
| `allowed_residence_cell` | `AllowedResidenceCellRegistry` | 許可居住セル allowlist の Merkle root 管理 |
| `membership` | `MembershipRegistry`, `MembershipPass` | Membership SBT の発行・居住セル管理 |
| `identity_registry` | `IdentityRegistry` | KYC / World ID の duplicate key binding と本人確認記録 |
| `identity_result_v1` | `IdentityVerificationResult` | TEE 署名済み本人確認結果の BCS decode と検証 |
| `metadata_verifier` | `VerifierRegistry` | Nautilus enclave の鍵・PCR 管理と署名検証（earthquake / identity / **census** family） |
| `accessor` | — | 外部公開エントリーポイント集約（version / pause チェック → 各モジュール委譲） |
| `reader` | — | 読み取り専用ヘルパー |

旧設計の `program`（generic Program / Campaign）、`payout_policy`（`PayoutPolicy` /
`CampaignBudget`）、`DesignatedPool`、`DisasterCampaignBinding` は廃止する。
Campaign が DisasterEvent / Category Pool との紐付け・資金・床予算 escrow・パラメータ・
ラウンド状態を単一オブジェクトで持つ。

user-facing API は `accessor` module に寄せる。entry は薄く保ち、
検証と状態遷移は package 内 helper（`public(package)`）に委譲する。

## 4. Pool 構成と資金の流れ

災害向けのプールは Category / Campaign の2層のみとし、これ以外の災害用プール種別は作らない。

| Pool | 個数 | 役割 |
| --- | --- | --- |
| Category Pool | 用途（災害種別）ごとに1つ・**常設** | 平常時寄付の受け皿。**床払いの第1資金源**。**MVP では earthquake の1つのみ作成**。期間・ラウンドの概念は持たない |
| Campaign Pool（`Campaign.balance`） | 災害ごとに1つ・**自動作成・期間限定** | 当該災害の**本払い**専用。床払いには使わない |
| Main Pool | プラットフォームに1つ | 共通支援。指定なし寄付の受け皿、**床払いの第2資金源**、sweep の受け皿 |
| Operations Pool | プラットフォームに1つ | 運営費。寄付時に源泉徴収された分だけが入る |

寄付の分割（寄付受領時に atomic に3分割。比率は毎回 `DonationSplit` イベントへ記録する）:

```text
特定災害指定（Campaign 宛て） : 90% Campaign / 5% Main / 5% Operations
用途指定（Category 宛て）     : 90% Category / 5% Main / 5% Operations
指定なし                      : 95% Main / 5% Operations
```

- **campaign_ops_cap**（初期値 50,000 USDC）: Campaign 宛て寄付の運営費受取に対する
  Campaign 単位の絶対額上限（災害特需批判への対策）。上限到達後は ops 相当分（5%）を
  Main へ自動ルーティングする。**Category 宛て・指定なし寄付の 5% には cap を適用しない**
  （平常時の定率手数料として扱う）。
- Campaign の寄付期間（30日）終了後に当該 Campaign へ届いた寄付は、Campaign 取り分を
  Main へルーティングする。
- **Main / Category / Campaign Pool から運営宛に引き出す関数は存在させない。**
  Operations Pool からの支出は自由だが、金額・送金先・reason_code を必ずイベント記録する。
- 対応通貨は MVP では Circle Sui USDC のみ（decimals = 6）。

資金の流れ（全体像）:

```text
寄付 ──┬─ Campaign 宛て ─→ 90% Campaign / 5% Main / 5% Ops（ops cap 付き）
       ├─ Category 宛て ─→ 90% Category / 5% Main / 5% Ops
       └─ 指定なし      ─→ 95% Main / 5% Ops

床払い（Round 0, 即時） : Category(escrow) + Main(escrow) ─→ 受給者
本払い（Round 1+, 締切後）: Campaign ─→ 受給者
最終 sweep              : Campaign 残額 ─→ Main
```

非災害用途（学生支援等）は、寄付の受け皿としては Category Pool 基盤にそのまま載るが、
受給資格・支払いロジックが災害 Claim と別物のため、支払い側は別 Program として将来実装する。
MVP では非災害 Category Pool を作成しない。Category Pool の struct / 関数は
用途追加に耐える generic な設計とする。

## 5. オブジェクト設計

### 5.1 CategoryPool（shared、用途ごとに1つ・常設）

```move
public struct CategoryPool has key {
    id: UID,
    version: u64,
    category: u8,                      // CATEGORY_EARTHQUAKE = 1（MVP はこれのみ）
    balance: Balance<USDC>,

    // リアルタイム表示用
    total_received_usdc: u64,          // 累計流入（寄付の Category 取り分）
    total_floor_funded_usdc: u64,      // 床払いへ拠出した累計（escrow 純額。返還で戻った分は控除しない総拠出）

    created_at_ms: u64,
}
```

- 作成は admin の `create_category_pool` のみ。`CategoryRegistry` で
  `category → pool_id` の一意性を強制し、同一用途の二重作成を拒否する。
- 期間・ラウンド・パラメータスナップショットを持たない。
  Category 宛て寄付の split はモジュール定数の現在値を適用する。
- 床予算は Campaign 側へ**物理的に escrow（move）**する方式のため、`earmark` 用フィールドは不要
  （escrow 済み分は `balance` から既に控除されている。可処分残高 = 現在の `balance`）。

### 5.2 Campaign（shared、災害ごとに1つ・期間限定）

```move
public struct Campaign has key {
    id: UID,
    version: u64,

    // ---- DisasterEvent / CategoryPool との紐付け（作成時固定） ----
    disaster_event_id: ID,
    event_uid: vector<u8>,              // 32 bytes
    event_revision: u32,
    category_pool_id: ID,               // 自動で1対1紐付け。裁量なし

    // ---- 本払い資金（Round 1 以降） ----
    balance: Balance<USDC>,

    // ---- 床払い escrow（Round 0。Category/Main から move して保持） ----
    floor_balance: Balance<USDC>,
    floor_from_category_usdc: u64,      // escrow のうち Category 由来（返還按分用）
    floor_from_main_usdc: u64,          // escrow のうち Main 由来（返還按分用）

    // ---- センサス確定値（set_floor_census で1度だけ確定。以後不変） ----
    census_set: bool,                   // floor_ratio 確定済みか
    floor_amount_by_band: vector<u64>,  // band_target[b] × floor_ratio_bps / 10000（固定）
    floor_budget_returned: bool,        // Day 30 の未消化返還済みフラグ

    // ---- リアルタイム表示用 ----
    total_donated_usdc: u64,            // Campaign 取り分の寄付累計
    total_paid_usdc: u64,               // 床払い + 本払いの支払済み総額
    ops_withheld_usdc: u64,             // この Campaign 起点で Ops へ送った累計（ops cap 判定）

    // ---- 作成時スナップショット（以後不変） ----
    terms: CampaignTerms,

    // ---- 締切（作成時に定数から導出。donation_end のみ admin 延長可） ----
    donation_end_ms: u64,               // created + 30日（床予算返還・Round 1 の基準）
    claim_end_ms: u64,                  // created + 21日（変更不可）

    // ---- 申請状態（band 別検証済み数はリアルタイム表示にも使う） ----
    verified_count_by_band: vector<u64>,

    // ---- 本払いラウンド状態（最新ラウンドのみ。過去は RoundFinalized イベントで追跡） ----
    current_round: u64,                 // 0 = 本払い未 finalize
    round_finalized_at_ms: u64,
    round_payout_by_band: vector<u64>,  // finalize で確定。claim（本払い経路）はこれを読むだけ
    closed: bool,                       // residual sweep 済み
    sweep_eligible: bool,

    // ---- 運用 ----
    paused: bool,
}

public struct CampaignTerms has store {
    band_target_usdc: vector<u64>,      // [band1, band2, band3]
    round_cap_multiplier: u64,          // 3
    floor_target_ratio_bps: u64,        // 5000 (= 0.5)
    min_claim_band: u8,
    split_campaign_bps: u64,            // 9000
    split_main_bps: u64,                // 500
    split_ops_bps: u64,                 // 500
    campaign_ops_cap_usdc: u64,
    round_interval_ms: u64,
    min_payout_per_recipient_usdc: u64,
    category_annual_event_divisor: u64, // 5（床第1層: Category 可処分 ÷ N）
    floor_main_share_bps: u64,          // 2000（床第2層: Main 可処分 × 20%）
}
```

dynamic field（`Campaign.id` 配下）:

```move
// 申請レコード: key = pass_lineage_id
public struct ClaimApplication has copy, drop, store {
    band: u8,
    applied_at_ms: u64,
    verified: bool,
    verified_in_round: u64,     // 検証完了時点の current_round。次の finalize から本払い参加
    floor_claimed: bool,        // 床払い受取済み
    excluded: bool,             // 不正確定による除外
}

// 本払い受取済みフラグ: key = PayoutKey, value = true
public struct PayoutKey has copy, drop, store {
    pass_lineage_id: ID,
    round: u64,
}
```

`Campaign` は Sui protocol の 32 フィールド制限に収まるよう、保存が必要な状態だけを持つ。
作成時固定の 12 個のルールは `CampaignTerms` にまとめ、進行中 Campaign の不変性を保つ。
`category`、`created_at_ms`、センサス集計、床払い件数、申請件数、ラウンド支払い件数は
`CampaignCreated` / `FloorCensusSet` / `ClaimSubmitted` / `FloorPaid` /
`RoundFinalized` / `PayoutClaimed` イベントから取得する。
将来の拡張データは dynamic field で持つ。

dapp は `total_donated_usdc`・`verified_count_by_band`・`terms.band_target_usdc`・
`terms.round_cap_multiplier`・`floor_amount_by_band`・`total_paid_usdc` とイベント集計で
「今いくら集まっているか」「床払い/本払いで1人あたりいくら届きそうか」を計算できる。

### 5.3 MainPool（shared、プラットフォームに1つ）

```move
public struct MainPool has key {
    id: UID,
    version: u64,
    balance: Balance<USDC>,
    total_received_usdc: u64,
    total_floor_funded_usdc: u64,    // 床払いへ escrow した累計
    total_swept_in_usdc: u64,        // sweep / 期限後寄付 / ops cap 超過 / 床予算返還の受入累計
    reserve_floor_usdc: u64,         // 床第2層 escrow 後も維持すべき絶対額
    created_at_ms: u64,
}
```

Main Pool から出る経路は、**床払い escrow（set_floor_census 時）のみ**である。
本払い（Round 1 以降）には Main を使わない。escrow した床予算の未消化分は Day 30 に返還される。

### 5.4 OperationsPool（shared、プラットフォームに1つ）

```move
public struct OperationsPool has key {
    id: UID,
    version: u64,
    balance: Balance<USDC>,
    total_received_usdc: u64,
    total_spent_usdc: u64,
    created_at_ms: u64,
}
```

入金経路は寄付時の源泉徴収（5%）のみ。Operations Pool への直接寄付関数は作らない。

### 5.5 所有モデルまとめ

| オブジェクト | 所有 | version |
| --- | --- | --- |
| `CategoryPool` / `Campaign` / `MainPool` / `OperationsPool` | shared | あり |
| `CategoryRegistry` / `MembershipRegistry` / `IdentityRegistry` / `VerifierRegistry` / `DisasterRegistry` / `DonorRegistry` / `AllowedResidenceCellRegistry` / `PauseState` | shared | あり（V2 移行時に付与） |
| `MembershipPass` / `DonorPass` / `ClaimReceipt` | owned（owner へ transfer、`has key` only） | 不要 |
| `DisasterEvent` | shared（immutable に使う） | 不要 |
| `AdminCap` | owned（admin） | 不要 |

## 6. DisasterEvent と Campaign の自動作成

### 6.1 DisasterEvent（現行実装を仕様とする）

`disaster_event::create_from_signed_payload` は次を行う:

1. `payload_bcs` の長さ上限（4096 bytes）を検証する。
2. `metadata_verifier::assert_enclave_signed_bytes` で earthquake oracle family の
   enclave 署名（Ed25519）・PCR 整合・instance 有効性・有効期限を検証する。
3. `payload::decode_finalized` で BCS decode し、intent / oracle_version / hazard_type /
   status = finalized / severity_band(1–3) / 各フィールド長 / freshness
   （`freshness_deadline_ms == verified_at_ms + 21,600,000ms` かつ未来）を検証する。
4. `DisasterRegistry` の dynamic field で `(event_uid, event_revision)` の重複と
   stale revision（最新 revision 以下）を拒否する。
5. `DisasterEvent` shared オブジェクトを作成する（payload 全文・署名・verifier 情報・
   `affected_cells_root`・`occurred_at_ms` 等を保存）。

### 6.2 Campaign の自動作成

DisasterEvent の finalize と**同一トランザクション内**で Campaign を作成する。
**この時点では floor_ratio は未確定（`census_set = false`）であり、床予算 escrow も行わない。**
floor_ratio の確定は後段の `set_floor_census`（§7）で行う。

```move
// disaster_event::create_from_signed_payload の末尾から呼ぶ。public エントリーは作らない
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

- 作成条件: `severity_band >= MIN_CLAIM_BAND`
  （= band ≥ min_claim_band の affected cell が1つ以上存在することの on-chain 代理条件。
  payload の `severity_band` が affected cells の最大 band であることは verifier 側仕様で担保する）。
  条件を満たさない場合は Campaign を作らず DisasterEvent のみ作成する（abort しない）。
- 人間の判断は入らない。**admin の裁量による Campaign 作成は無い。**
- **Category Pool との自動1対1紐付け**: `hazard_type` から category（earthquake = 1）を導出し、
  `CategoryRegistry` の登録 pool_id と引数 `category_pool` の一致を assert する。
  relayer は正しい CategoryPool を tx 引数として渡すだけで、選択の余地はない。
- モジュール定数の現在値をコピーして Campaign を構築し share する。
  `donation_end_ms = now + DONATION_PERIOD_MS`、`claim_end_ms = now + CLAIM_PERIOD_MS`。
  床関連フィールドは未確定（`census_set = false`、`floor_balance = 0`）で初期化する。
- 同一 `event_uid` の revision 更新（re-finalize）では新 Campaign を作らない
  （`DisasterRegistry` の dynamic field `event_uid → campaign_id` で判定）。
- イベント: `CampaignCreated`（スナップショットした全パラメータ値と category_pool_id を含める。
  床関連は census 確定時に `FloorCensusSet` で別途記録）。

### 6.3 Category Pool の作成（admin、災害種別追加時）

```move
public fun create_category_pool(
    _: &AdminCap,
    registry: &mut CategoryRegistry,
    category: u8,
    ctx: &mut TxContext,
): ID
```

- `category` が未登録であることを assert する（同一用途の二重作成を拒否）。
- イベント: `CategoryPoolCreated { pool_id, category, created_at_ms, actor }`（**記録必須**）。
- MVP では genesis（migrate）時に earthquake の1つのみ作成する。
  以後の新規作成は災害種別（verifier）追加時に admin が行う。

## 7. 床払い（Floor / Round 0）と後置センサス

床払いは「特設募金箱が寄付を集め終わるのを待たずに、被災者へ最低ラインの支援金を即時に届ける」
仕組みである。Campaign Pool は「30日集めてから配る」器であり時系列上初動に使えないため、
床払いは**常設 Pool（Category → Main）** が担う。

### 7.1 なぜ後置センサスか（オンチェーン集計の不可能性）

床払い額を「申請タイミング非依存」にするには、配り始める前に分母
`max_liability = Σ_band ( 対象地域の災害前登録メンバー数(band別) × band目標額 )` を確定する必要がある。
これはオンチェーンで計算できない:

1. affected cells は Merkle root しかオンチェーンに無く、セルを列挙できない。
2. 対象セルは最大 1,000,000（`payload.move`）。1 tx で回せない。
3. cutoff（`home_cell_registered_at_ms < occurred_at_ms`）は現在値カウンタでは正確に絞れない。
4. Move は dynamic field を列挙できない（全件集計の API が無い）。

したがって登録者数は**署名済みオフチェーン集計（後置センサス、#296）** で供給する。
集計は地震 TEE とは別の census worker（`infra/aws/sonari-verifier-runner`）が、
公開済み affected cells アーティファクト＋membership スナップショットから band 別に数え、
`(event_uid, event_revision, affected_cells_root)` に束縛して署名する。
数値は公開チェーン状態から第三者が再現・検算できるため、信頼モデルは既存の TEE 署名と同じ。
集計の詳細仕様・データ源・署名方式は **issue #296** を参照。

### 7.2 set_floor_census（センサス受理・floor_ratio 確定・床予算 escrow）

```move
public fun set_floor_census(
    pause_state: &PauseState,
    campaign: &mut Campaign,
    disaster_event: &DisasterEvent,
    verifier_registry: &VerifierRegistry,
    category_pool: &mut CategoryPool,
    main_pool: &mut MainPool,
    census_bcs: vector<u8>,
    signature: vector<u8>,
    public_key: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
)
```

- 事前条件 / assert:
  - version / pause / `campaign.paused == false`、`census_set == false`（**1度だけ**。`EFloorCensusAlreadySet`）。
  - `now < campaign.donation_end_ms`（Day 30 より前。床払いを開くため）。
  - `metadata_verifier::assert_enclave_signed_bytes`（**census family**）で署名・PCR・instance 有効性を検証。
  - `census_result::decode_verified` で BCS decode。`(event_uid, event_revision, affected_cells_root)` が
    `disaster_event` のそれと一致すること（`EFloorCensusBindingMismatch`）。
  - `object::id(category_pool) == campaign.category_pool_id`、Main は genesis の Main Pool であること。
- 処理（このとき1度だけ計算して固定する）:

```text
registered[b]   = census.registered_members_by_band[b]
max_liability   = Σ_b registered[b] × band_target[b]
if max_liability == 0:
    census_set = true; floor_ratio_bps = 0; floor_amount_by_band = [0,0,0]   // 床払いなし
    return（escrow しない）

floor_target    = FLOOR_TARGET_RATIO_BPS/10000 × max_liability        // ratio 0.5 に必要な予算

# 第1層: Category Pool（可処分 ÷ N）
cat_disposable  = category_pool.balance
draw_category   = min(floor_target, cat_disposable / CATEGORY_ANNUAL_EVENT_DIVISOR)   // ÷5

# 第2層: Main Pool（不足分のみ。可処分 × 20%、reserve floor 維持）
rem             = floor_target − draw_category
main_disposable = max(main_pool.balance − main_pool.reserve_floor_usdc, 0)
draw_main       = min(rem, main_disposable × FLOOR_MAIN_SHARE_BPS / 10_000)           // ×20%

floor_budget    = draw_category + draw_main
floor_ratio_bps = min(FLOOR_TARGET_RATIO_BPS, floor_budget × 10_000 / max_liability)  // ≤ 5000
floor_amount_by_band[b] = band_target[b] × floor_ratio_bps / 10_000                   // 固定
```

  - `draw_category` / `draw_main` を各 Pool から**物理的に move**して `campaign.floor_balance` へ escrow し、
    `floor_from_category_usdc` / `floor_from_main_usdc` に記録。
    各 Pool の `total_floor_funded_usdc` を加算。
  - `census_set = true`、`floor_amount_by_band` と escrow 元金額を保存。
    `registered_members_by_band`、`max_liability_usdc`、`floor_ratio_bps` はイベントで残す。
- イベント: `FloorCensusSet { campaign_id, registered_members_by_band, max_liability_usdc,
  floor_ratio_bps, floor_amount_by_band, draw_category_usdc, draw_main_usdc }`。
- 実行者: permissionless（誰でも可。署名検証が gate）。off-chain の census worker / relayer が submit する。

> **設計意図**: 拠出上限を「可処分 ÷ N」「可処分 × 20%」とすることで Pool は構造上空にならず、
> N（`CATEGORY_ANNUAL_EVENT_DIVISOR`）を年間想定イベント数とすることで連続災害でも各災害が
> ほぼ同水準の床を受けられる持続的支出ルールになる。分母 `max_liability` を作成直後に固定するため、
> 受給者間の早い者勝ち（予算枯渇による金額差）も発生しない。

### 7.3 床払いの受取（単一入口 `claim` の床払い経路、`return_floor_budget` 実行まで・本人確認完了しだい随時）

床払いには専用 entry を設けず、単一入口 `claim`（§9.1）の中で処理する。
`claim` は次の条件で床払い経路（旧 `claim_floor`）を実行する:

- 床払い可否 `will_pay_floor` = `floor_claimed == false` && `census_set == true` &&
  `floor_budget_returned == false`。
- 床払いを行うときは本人確認を要求する: 有効な `ClaimApplication`（`verified == true` /
  `excluded == false`）、IdentityRegistry の有効な記録・provider bit、duplicate key が
  この SBT に紐づくこと（`identity_registry::assert_duplicate_key_bound_to_pass`）。
  初回 `claim` では同じ呼び出しの中で申請登録と本人確認を確立してから床払いへ進む。
- 処理（金額計算は旧 `claim_floor` から変えない）:
  1. `amount = campaign.floor_amount_by_band[band]` を読むだけ。再計算しない。
  2. `floor_claimed = true`、`total_paid_usdc += amount`。
  3. `campaign.floor_balance` から `amount` を引いて owner へ transfer。
     （実申請者数 ≤ 登録メンバー数のため、床予算は構造上枯渇しない。）
  4. 共通ヘルパー `pay_claim` が `ClaimReceipt`（`kind` = 床払い、owned）を発行する。
- イベント: `FloorPaid { campaign_id, pass_lineage_id, band, amount_usdc, recipient, paid_at_ms }`
  （型名・フィールドは不変。dapp が購読する）。支払い件数と床払い合計はこのイベントを集計して読む。
- **金額は申請・検証のタイミングに依存しない**（変わるのは受取時期のみ）。

### 7.4 return_floor_budget（未消化床予算の返還、Day 30）

```move
public fun return_floor_budget(
    pause_state: &PauseState,
    campaign: &mut Campaign,
    category_pool: &mut CategoryPool,
    main_pool: &mut MainPool,
    clock: &Clock,
    ctx: &mut TxContext,
)
```

- 事前条件: `now >= campaign.donation_end_ms`（Day 30 以降）、`floor_budget_returned == false`、
  `census_set == true`、`object::id(category_pool) == campaign.category_pool_id`。
- 処理: `campaign.floor_balance` の残額を **escrow 元の按分**
  （`floor_from_category_usdc : floor_from_main_usdc`）で Category / Main へ返す。
  端数は Category へ寄せる。Main へ戻した分は `total_swept_in_usdc` に計上。
  `floor_budget_returned = true`。以後 `claim` の床払い経路は不可（受取期限到来）。
- イベント: `FloorBudgetReturned { campaign_id, returned_to_category_usdc, returned_to_main_usdc }`。
- 実行者: permissionless。

## 8. Membership SBT・本人確認（現行実装を仕様とする）

### 8.1 Membership SBT

Membership SBT は `has key` only の owned object とする。通常 transfer API は提供しない。

```move
public struct MembershipPass has key {
    id: UID,
    owner: address,
    pass_lineage_id: ID,
    status: u8,                       // Active=1 / Suspended=2 / Revoked=3 / Migrated=4
    status_label: String,
    issued_at_ms: u64,
    account_created_at_ms: u64,
    home_cell: u64,                   // H3 resolution 7
    home_cell_registered_at_ms: u64,
    terms_version: u64,
    signed_statement_hash: vector<u8>,
}
```

- 登録は**無料**（fee なし）。1 address につき 1 つ（`MembershipRegistry` の
  dynamic field `address → pass_lineage_id` で重複発行を拒否）。
- `MembershipRegistry` は lineage ごとに `MembershipRecord`
  （current_pass_id / current_owner / status）を持ち、Claim 系操作では
  `assert_current_pass_precheck` で「pass が active・sender が owner・registry record と整合」を検証する。
- `home_cell` はユーザー自己申告の居住セル。H3 resolution 7 のみを扱い、
  登録・変更時に `AllowedResidenceCellRegistry` の Merkle root に対する proof 検証を必須とする。
  root は admin が作成・更新でき、更新後は旧 proof が無効になる。
- 居住セルは後から変更でき、変更時刻を `home_cell_registered_at_ms` に保存する
  （災害後変更の駆け込み Claim は cutoff 判定で拒否される）。

> **#296 連携（要対応）**: 後置センサスの indexer 化のため、`home_cell` の登録・変更を
> イベント化する（例: `HomeCellRegistered { lineage, home_cell, registered_at }`）。
> 現状 `home_cell` はどのイベントにも出ておらず（`MembershipPassIssued` は cell を含まず、
> `set_home_cell` はイベント無発行）、indexer がイベントだけで居住セルを追えない。
> 本書では「イベント追加」を target 仕様に含める。

### 8.2 IdentityRegistry / 本人確認結果の受理 / metadata_verifier

- `IdentityRegistry` は KYC(1) / World ID(2) の duplicate key binding と
  `IdentityVerificationRecord`（provider_mask、verified/expires、terms/statement hash）を持つ。
  duplicate key が別 SBT に bind 済みなら reject（`EIdentityKeyAlreadyBound`）、
  同一 provider の再 verify は replay 検査で reject（`EIdentityProviderReplay`）。
- `accessor::update_identity_verification` は identity family の enclave 署名を検証し、
  `identity_result_v1::decode_verified`（intent / version / provider / verified / 時刻整合 /
  32-byte hash 長）で decode、registry/membership/owner 整合を確認して record を保存・更新する。
- `metadata_verifier` の `VerifierRegistry` は family ごと（earthquake oracle = 3 / identity = 4 /
  **census = 5**）の `VerifierConfig`（PCR0/1/2）と `EnclaveInstance`（公開鍵・有効期限）を管理し、
  `assert_enclave_signed_bytes` で config 有効性・PCR 一致・instance 有効期限・Ed25519 署名を検証する。
  admin は key / config の追加・PCR 更新・無効化ができる（EIF 更新時の PCR 再登録）。

## 9. 受給フロー（単一入口 `claim`）

被災者の受け取りは **単一の `claim` 入口**に集約する。旧設計の 4 入口
（`submit_claim` / `verify_claim` / `claim_floor` / `claim_payout`）と独立した
`finalize_round` 入口は廃止し、申請・本人確認・床払い・本払い・ラウンド確定（lazy finalize）を
`claim` 1 本で扱う。**お金の計算ルール（床比率・band 目標額・按分・上限 ×3）は旧実装から変えない。**

タイムライン（Campaign 作成 = Day 0）:

```text
Day 0        DisasterEvent finalize + Campaign 自動作成（同一 tx、Category Pool 自動紐付け）
Day 0+       set_floor_census（センサス受理 → floor_ratio 確定 → 床予算 escrow → 床払い開始）
Day 0–30     寄付受付（Campaign 宛て 90/5/5）
Day 0–21     claim（初回）: 申請＋本人確認を 1 回で確立し、床払い可能なら即時受取
Day 0+       claim（床払い経路）: `return_floor_budget` 実行前の検証完了済み受給者へ固定額を随時支払い
Day 30以降   return_floor_budget（未消化床予算を Category / Main へ返還）
             claim の呼び出しが Round 1 を lazy finalize → 本払い開始（Campaign 残高のみ）
以後90日ごと  claim が境界を跨いだ初回呼び出しで次ラウンドを lazy finalize（補填なし）
終了時/期限超過  sweep_residual → 端数のみ Main Pool へ（Category へは流さない）
```

本払い額の原則:

```text
Band 目標額: Band1 = 50 / Band2 = 150 / Band3 = 300 USDC（比率 1:3:6、地域係数なし）
ラウンド上限: 目標額 × 3（ROUND_CAP_MULTIPLIER）

ラウンド確定（lazy finalize。各ラウンド1回だけ。資金源は Campaign Pool のみ）:
  liability = Σ ( band別の検証済み対象者数 × band目標額 )
  ratio     = min( campaign_balance / liability, 3.0 )     // 補填なし。Category/Main は使わない
  band別支払額 = 目標額 × ratio
  → Campaign に保存。以後そのラウンド内では不変

claim（本払い経路）:
  保存済みの band 別支払額を読むだけ。計算しない。生のプール残高から導出しない。
  受取済みフラグ（ラウンド単位）で二重受取を防ぐ。受取先は Membership SBT owner の Sui address。
```

本人確認の種類で支給率を変えない（KYC / World ID どちらも満額）。
初回資格確立と床払いでは有効な本人確認記録を要求し、本払いのみの経路では
すでに検証済みの `ClaimApplication` と `verified_in_round` を支払い条件にする。
受給資格判定（本書 §9）は床払い・本払いとも同一。

### 9.1 受給単一入口 `claim`（初回申請・本人確認・床払い・本払いを内包）

```move
public fun claim(
    pause_state: &PauseState,
    campaign: &mut Campaign,
    disaster_event: &DisasterEvent,
    identity_registry: &IdentityRegistry,
    membership_registry: &MembershipRegistry,
    pass: &MembershipPass,
    identity_provider: u8,
    duplicate_key_hash: vector<u8>,
    leaf: Option<AffectedCellLeaf>,
    proof: vector<ProofStep>,
    clock: &Clock,
    ctx: &mut TxContext,
)
```

`accessor::claim` が version / pause を検査し `campaign` 内部の `claim` へ委譲する。
先頭ガード（全経路共通）: version 一致、global / target / campaign 非 pause、`closed == false`、
SBT precheck（active / sender = owner / registry record 整合）。
申請の有無（`ClaimApplication` 未登録か = `is_first_time`）で経路を分ける。

**初回（`is_first_time == true`、旧 `submit_claim` + `verify_claim` 相当）**:

| 分類 | 条件 | abort |
| --- | --- | --- |
| Window | `now < campaign.claim_end_ms` | `EClaimWindowClosed` |
| Leaf | `leaf` が `Some`（初回は affected cell leaf 必須） | `EClaimLeafRequired` |
| Disaster | `campaign.disaster_event_id == id(disaster_event)`、leaf の event_uid / revision 一致 | `EDisasterEventMismatch` |
| Area | `AffectedCellLeaf` の Merkle proof が `affected_cells_root` に対して valid | `EInvalidAffectedCellProof` |
| Band | `leaf.cell_band >= campaign.min_claim_band`（スナップショット値） | `EClaimBandTooLow` |
| Time | `account_created_at_ms < occurred_at_ms`（cutoff = USGS 地震発生時刻） | `EAccountCreatedAfterCutoff` |
| Time | `home_cell_registered_at_ms < occurred_at_ms` | `EHomeCellRegisteredAfterCutoff` |
| Area | `pass.home_cell == leaf.h3_index` | `EResidenceCellMismatch` |
| Identity | 有効な本人確認記録・provider bit・duplicate key 束縛 | `EIdentity*` |

`AffectedCellLeaf.cells_generation_method` は `SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1 = 1`、`SHAKEMAP_HDF_H3_AREA_WEIGHTED_P90_V1 = 2`、`SHAKEMAP_GRIDXML_H3_CENTER_BILINEAR_V1 = 3` を固定値として扱う。現行 grid.xml path の leaf は value `3` で、ShakeMap 実データ軸に対するH3セル中心の bilinear interpolation に由来する。

  - 検証を通すと `ClaimApplication { band, verified: true, verified_in_round: current_round, ... }`
    を登録し、`ClaimSubmitted` と `ClaimVerified` を発行する。
  - 申請受付は Day 21 で締切済みのため、後から `claim` を呼んでも申請者集合は増えない。
    現行パラメータでは `claim_end_ms < donation_end_ms` なので、Round 1 以降の
    lazy finalize 後に新規検証者が増えることは想定しない。

**既申請（`is_first_time == false`、旧 `claim_floor` / `claim_payout` 相当）**:

  - `ClaimApplication` が `verified == true`（`EClaimNotVerified`）かつ
    `excluded == false`（`EClaimExcluded`）であること。
  - `leaf` / `proof` が渡されても破棄する（disaster binding / Merkle 検証は行わない）。

**lazy finalize**: 経路判定後、時間境界を跨いでいれば（Round 1 は Day 30 以降、
Round N+1 は前回 finalize + 90日 以降）`finalize_round_v2`（§9.2）を 1 回だけ実行して
ラウンドを確定する。独立した `finalize_round` 入口は持たない。

**床払い経路（旧 `claim_floor`、`return_floor_budget` 実行まで）**:
`will_pay_floor` = 床未受取 && `census_set` && `floor_budget_returned == false` のとき:

  1. 本人確認（有効な record・provider bit・duplicate key 束縛）を要求する。
  2. `amount = campaign.floor_amount_by_band[band]` を読むだけ（再計算しない）。
  3. `floor_claimed = true`、`total_paid_usdc += amount`、`floor_balance` から owner へ transfer。
  4. 共通ヘルパー `pay_claim` が `ClaimReceipt { kind = 床払い }` を発行し `FloorPaid` を発行。

**本払い経路（旧 `claim_payout`、`current_round >= 1`）**:

  - `verified_in_round < current_round`（finalize 前に検証済みの者のみ。早期検証ガード）かつ
    `PayoutKey { pass_lineage_id, current_round }` 未登録のとき支払う。
  1. `amount = round_payout_by_band[band]` を読むだけ（再計算しない）。
  2. `PayoutKey` を登録、`total_paid_usdc += amount`、`balance` から owner へ transfer。
  3. `pay_claim` が `ClaimReceipt { kind = 本払い }` を発行し `PayoutClaimed` を発行。

**前進保証**: 初回登録でもなく、床払い・本払いのいずれの支払いも発生しなかった場合は
`ENothingToClaim` で abort する。床払いは pass あたり1回、本払いは campaign / round あたり1回に制限する。

> **イベント不変**: dapp が購読する `FloorPaid` / `PayoutClaimed`（および
> `ClaimSubmitted` / `ClaimVerified`）の型名・フィールドは旧実装から変えていない。
> 旧 `PayoutReceipt` / `FloorReceipt` は単一の `ClaimReceipt`（`kind` で床/本払いを区別）へ統合した。

### 9.2 内部ラウンド確定 `finalize_round_v2`（`claim` 内 lazy finalize）

ラウンド確定は独立 entry ではなく `claim` の中で遅延実行する（`public(package)`、公開 entry なし）。
資金源は **Campaign Pool のみ**。Category / Main は使わない（本払いで補填しない）。

- 実行契機: `claim` 内で時間境界に達した初回呼び出し。
  Round 1 は `now >= donation_end_ms`（Day 30）、Round N 以降は
  `now >= round_finalized_at_ms + round_interval_ms`。
- 計算（このラウンド内で不変な値を一度だけ計算して保存する）:

```text
liability   = Σ_band ( eligible_count[band] × band_target[band] )
              eligible_count[band] = verified_count_by_band[band] − band別除外数
campaign_av = campaign.balance.value()
ratio       = min( campaign_av / liability, round_cap_multiplier )     // min(base, 3.0)
band_payout[b] = band_target[b] × ratio                                // u128 演算・切り捨て
```

  - `liability == 0` の場合は支払額ゼロでラウンドを進める（資金は次ラウンド / sweep へ）。
  - 終了判定（受給者あたり支払いが `MIN_PAYOUT_PER_RECIPIENT_USDC` 未満など）を満たす場合は
    `sweep_eligible` を立て、以後 `sweep_residual`（§9.3）で残額を回収できる状態にする。
  - `current_round += 1`、`round_finalized_at_ms = now`、`round_payout_by_band` を保存する。
    `eligible_count` は `RoundFinalized` イベントで残す。
- イベント: `RoundFinalized { campaign_id, round, liability, campaign_available, band_payout[],
  eligible_count, finalized_at_ms }`。

### 9.3 sweep_residual（最終スイープ、誰でも実行可）

- 事前条件: `closed == false`、`floor_budget_returned == true`（床予算返還後）、かつ次のいずれか:
  - **Case A**: finalize が立てた `sweep_eligible == true`（終了判定済み）。
  - **Case B（タイムアウト回収）**: finalize の実行有無に依存せず、ラウンド間隔が経過したら回収する。
    「誰も claim せず finalize も走らないまま資金が永久に stuck する」状態を防ぐための経路。
    基準時刻は `current_round == 0` なら `donation_end_ms`、`current_round >= 1` なら
    直近の `round_finalized_at_ms`。`now >= 基準時刻 + round_interval_ms` で回収できる。
  - どちらも満たさない場合は `ESweepNotEligible` で abort。
- 処理: `campaign.balance` 残高全額を **Main へ**移して `closed = true`
  （**Category Pool へは流さない**）。
- イベント: `ResidualSweep { campaign_id, amount_usdc, final_round }`。

### 9.4 寄付関数

```move
public fun donate_to_campaign(
    pause_state: &PauseState, campaign: &mut Campaign,
    main_pool: &mut MainPool, ops_pool: &mut OperationsPool,
    coin: Coin<USDC>, clock: &Clock, ctx: &mut TxContext,
)
public fun donate_to_category(
    pause_state: &PauseState, category_pool: &mut CategoryPool,
    main_pool: &mut MainPool, ops_pool: &mut OperationsPool,
    coin: Coin<USDC>, ctx: &mut TxContext,
)
public fun donate_general(
    pause_state: &PauseState,
    main_pool: &mut MainPool, ops_pool: &mut OperationsPool,
    coin: Coin<USDC>, ctx: &mut TxContext,
)
```

- 額 > 0（`EZeroDonation`）。`donate_to_campaign` は `campaign.closed == false`。
- 分割は §4 のとおり。端数は指定先（Campaign / Category）/ Main（指定なし）に寄せる。
- `donate_to_campaign` のみ ops cap と寄付期間判定を適用し、超過分・期限後の
  Campaign 取り分は Main へ振り替える。`DonationSplit` イベントに実額と適用 bps、振替フラグを記録する。
- 寄付は **Campaign 本払い残高（`balance`）** に入る。床払い escrow（`floor_balance`）には入らない。
- DonorPass（tier 付き寄付者 SBT、Bronze/Silver/Gold）は記録用として維持する。
  `*_with_pass` 変種で既存 pass への履歴追記を提供する。Claim 権利は与えない。
- DonorPass tier は `total_donated_usdc` の raw units（USDC decimals = 6）で判定する。
  Bronze は「1 unit 以上寄付済み」を表す tier である。

| tier | raw units threshold | 表示額 |
| --- | ---: | ---: |
| None | `0` | 0 USDC |
| Bronze | `1` | 0.000001 USDC |
| Silver | `50_000_000` | 50 USDC |
| Gold | `250_000_000` | 250 USDC |

### 9.5 spend_operations（運営費支出）

```move
public fun spend_operations(
    _: &AdminCap, ops_pool: &mut OperationsPool,
    amount: u64, recipient: address, reason_code: u8, ctx: &mut TxContext,
)
```

- イベント `OpsSpend { amount, recipient, reason_code, actor }` を必ず発行する。
- reason_code: `1 = infra`, `2 = audit`, `3 = oracle_ops`, `4 = support`, `255 = other`。

## 10. Admin 権限と Pause

admin（`AdminCap`）に許す操作は次で**すべて**である:

| 操作 | 制約 | イベント |
| --- | --- | --- |
| `create_category_pool` | 災害種別（verifier）追加時のみ。category 重複は abort | `CategoryPoolCreated`（必須） |
| `extend_donation_period` | 延長のみ。短縮は abort | `DonationPeriodExtended` |
| `pause_campaign` / `unpause_campaign` | 不正検出時の一時停止 | `Paused` / `Unpaused`（必須） |
| `pause_global` / `pause_target` ほか | 既存 `PauseState` 機構 | `Paused` / `Unpaused` |
| `exclude_recipient` | 不正確定者を**次の finalize から**除外。確定済みラウンドの保存値は変更しない | `RecipientExcluded`（必須） |
| `spend_operations` | Operations Pool のみ | `OpsSpend`（必須） |
| verifier key / config / PCR 管理 | `metadata_verifier` 系（earthquake / identity / census） | 各 config イベント |
| `update_allowed_residence_cell_root` | 居住セル allowlist 更新（既存） | `AllowedResidenceCellRootUpdated` |
| `migrate_*` | version 引き上げのみ（§12） | — |

Campaign の任意作成、**floor_ratio の手動設定**、支払額・split・対象条件・期間（短縮方向）の変更、
Main / Category / Campaign Pool からの引き出しは admin にも**できない**。

`PauseState` は global pause と target pause（campaign / category pool / registry / pool 単位）
を持ち、donation / claim / floor / payout / verifier update 系の全エントリーで検査する。

## 11. 定数表

USDC は 6 decimals（1 USDC = 1_000_000 units）。すべて**モジュール定数**として持ち、
Campaign 作成時にスナップショットする。変更は package upgrade で行い、
**次に作成される Campaign から**適用される（Category 宛て・指定なし寄付の split は
常設 Pool のため upgrade 後の寄付から新定数を適用し、`DonationSplit` で毎回記録する）。

| 定数名 | 型 | 初期値 | 意味 |
| --- | --- | --- | --- |
| `VERSION` | `u64` | `1` | shared オブジェクトの現行バージョン |
| `CATEGORY_EARTHQUAKE` | `u8` | `1` | 地震カテゴリのコード値 |
| `BAND_1_TARGET_USDC` | `u64` | `50_000_000` | Band 1 目標額 50 USDC |
| `BAND_2_TARGET_USDC` | `u64` | `150_000_000` | Band 2 目標額 150 USDC |
| `BAND_3_TARGET_USDC` | `u64` | `300_000_000` | Band 3 目標額 300 USDC |
| `ROUND_CAP_MULTIPLIER` | `u64` | `3` | 本払いラウンド上限 = 目標額 × 3 |
| `FLOOR_TARGET_RATIO_BPS` | `u64` | `5_000` | 床払い目標比率 = 目標額の 50%（floor_ratio の上限） |
| `MIN_CLAIM_BAND` | `u8` | `1` | Claim / Campaign 作成の最低 band |
| `DIRECTED_SPLIT_TARGET_BPS` | `u64` | `9_000` | Campaign / Category 宛て寄付 → 指定先 90% |
| `DIRECTED_SPLIT_MAIN_BPS` | `u64` | `500` | Campaign / Category 宛て寄付 → Main 5% |
| `DIRECTED_SPLIT_OPS_BPS` | `u64` | `500` | Campaign / Category 宛て寄付 → Ops 5% |
| `GENERAL_SPLIT_MAIN_BPS` | `u64` | `9_500` | 指定なし寄付 → Main 95% |
| `GENERAL_SPLIT_OPS_BPS` | `u64` | `500` | 指定なし寄付 → Ops 5% |
| `CAMPAIGN_OPS_CAP_USDC` | `u64` | `50_000_000_000` | Campaign 宛て寄付の ops 受取上限 50,000 USDC（Campaign 単位。Category / 指定なしには非適用） |
| `DONATION_PERIOD_MS` | `u64` | `2_592_000_000` | Campaign 寄付受付 30日（床予算返還・Round 1 の基準） |
| `CLAIM_PERIOD_MS` | `u64` | `1_814_400_000` | 申請受付 21日 |
| `ROUND_INTERVAL_MS` | `u64` | `7_776_000_000` | 本払いラウンド間隔 90日 |
| `MIN_PAYOUT_PER_RECIPIENT_USDC` | `u64` | `1_000_000` | 本払いラウンド終了閾値（受給者あたり 1 USDC） |
| `CATEGORY_ANNUAL_EVENT_DIVISOR` | `u64` | `5` | 床第1層上限: Category 可処分 ÷ N（earthquake の年間想定対象イベント数。USGS 履歴で較正） |
| `FLOOR_MAIN_SHARE_BPS` | `u64` | `2_000` | 床第2層上限: Main 可処分 × 20% |
| `MAIN_RESERVE_FLOOR_USDC` | `u64` | `100_000_000_000` | 床第2層 escrow 後も Main に残す絶対額 100,000 USDC |
| `BPS_DENOMINATOR` | `u64` | `10_000` | bps 計算分母 |

按分・床比率計算は `(target as u128) * (available as u128) / (liability as u128)` の
u128 演算・切り捨てで行う。

## 12. version ガードとアップグレード方針

```move
const VERSION: u64 = 1;

// 全 public 関数の先頭（引数に取る全 shared オブジェクトに対して）
assert!(obj.version == VERSION, EVersionMismatch);
```

- 旧 package のコードはオンチェーンに残り続けるため、upgrade 後に旧エントリーを
  叩かれても version 不一致で abort させる。これが旧ロジック経由の資金移動を
  無効化する唯一の確実な手段であり、全 public 関数で必須とする。
- migrate は AdminCap ゲートで提供する（`version < VERSION` の assert 付き引き上げのみ）。
- struct フィールドの追加は upgrade では不可。Campaign / CategoryPool には
  contract が判断に使う締切・床予算・ラウンド状態だけを保存する。
  表示用集計はイベントで残し、将来の拡張は dynamic field で行う。
- 定数変更 = package upgrade。進行中の Campaign はスナップショット済みのため影響を受けない。
  `CampaignCreated` / `FloorCensusSet` イベントが適用値を自己記述するため、
  インデクサは定数のバージョン管理を必要としない。
- 現行実装（PayoutPolicy / CampaignBudget / DesignatedPool / 即時支払い claim）からの
  移行は、新 struct を genesis で作成 → 旧 Pool 残高を移送 → 旧入金関数を新 package で
  abort 実装に差し替えて遮断する。dev/testnet 段階のため進行中 Campaign は基本ゼロ前提。

## 13. イベント一覧

| イベント | 発行タイミング | 主なフィールド |
| --- | --- | --- |
| `CampaignCreated` | Campaign 自動作成 | disaster_event_id、event_uid/revision、category、category_pool_id、スナップショット全パラメータ、締切 |
| `FloorCensusSet` | set_floor_census | registered_members_by_band、max_liability、floor_ratio_bps、floor_amount_by_band、draw_category、draw_main |
| `FloorPaid` | claim（床払い経路） | pass_lineage_id、band、amount、recipient |
| `FloorBudgetReturned` | return_floor_budget | returned_to_category、returned_to_main |
| `CategoryPoolCreated` | Category Pool 新設（admin） | pool_id、category、actor |
| `DonationSplit` | すべての寄付 | target_kind（CAMPAIGN/CATEGORY/NONE）、各 Pool 実額、適用 bps、ops cap 超過振替額、期限後ルーティングフラグ、donor |
| `ClaimSubmitted` | claim（初回） | campaign_id、pass_lineage_id、band |
| `ClaimVerified` | claim（初回） | campaign_id、pass_lineage_id、band、verified_at_ms、verifier |
| `RoundFinalized` | claim 内 lazy finalize | round、liability、campaign_available、band_payout[]、eligible_count |
| `PayoutClaimed` | claim（本払い経路） | round、pass_lineage_id、band、amount、recipient |
| `OpsSpend` | spend_operations | amount、recipient、reason_code、actor |
| `RecipientExcluded` | exclude_recipient | pass_lineage_id、reason_code、round、actor |
| `ResidualSweep` | sweep_residual | amount、final_round |
| `DonationPeriodExtended` | extend_donation_period | old_end_ms、new_end_ms |
| `DisasterEventCreated` / `MembershipPassIssued` / `HomeCellRegistered`（新規・#296）/ `RegistryCreated` / `Paused` / `Unpaused` / `GenesisObjectCreated` / verifier config 系 | 各所 | — |

## 14. セキュリティ要件

| 区分 | 要件 |
| --- | --- |
| must | Pool 残高以上を支払わない |
| must | 床払いは確定済み `floor_amount_by_band` 以上を払わない。本払いは finalize で保存した band 別支払額以上を払わない（生のプール残高から金額を導出しない） |
| must | floor_ratio はセンサス署名検証後に1度だけ確定し、以後不変（admin も変更不可） |
| must | 床予算は Category(÷N) + Main(×20%, reserve floor) の上限内でのみ escrow する |
| must | Main Pool の reserve floor を床 escrow 後も侵さない |
| must | 床払いの資金源は Category/Main escrow（`floor_balance`）のみ。本払いの資金源は Campaign（`balance`）のみ。両者を混同しない |
| must | 未消化床予算は Day 30 に escrow 元へ按分返還する |
| must | Operations Pool を Relief payout 原資にしない |
| must | Main / Category / Campaign Pool から運営宛に引き出す関数を持たない |
| must | Ops 支出は金額・送金先・reason_code をイベント記録する |
| must | 寄付は受領時に atomic に分割し、比率をイベント記録する |
| must | ops cap は Campaign 宛て寄付のみに適用し、超過分は Main へ振り替える |
| must | Campaign と Category Pool の紐付けは hazard_type から決定論的に行う（裁量なし） |
| must | Nautilus 署名済み result（災害・本人確認・センサス）だけを信頼する |
| must | センサスは `(event_uid, event_revision, affected_cells_root)` への束縛と family/PCR を検証する |
| must | IdentityRegistry の有効な本人確認記録を初回資格確立と床払いに要求する。本払いのみの経路は検証済み `ClaimApplication` と `verified_in_round` で参加可否を判定する |
| must | provider 内 duplicate key を検証する |
| must | Membership SBT owner にだけ支払う |
| must | 床払いは pass あたり1回、本払いは campaign / round あたり1回に制限する |
| must | 全 shared オブジェクトの version を全 public 関数で検証する |
| must | paused 中の donation / claim / floor / payout / verifier update を拒否する |
| must not | raw personal data をオンチェーンに出す |
| must not | dapp、Relayer、Worker、census worker の input を署名検証なしに信用する |
| must not | DonorPass を Claim 権利として扱う |
| must not | admin に支払額・split・対象条件・期間（短縮方向）・floor_ratio の変更を許す |
| must not | オンチェーンで全 membership / 全 affected cells を集計しようとする（DF 列挙不可・コスト上限） |

## 15. テスト要件

| Test | 主要ケース |
| --- | --- |
| Membership | SBT issue、active check、duplicate owner reject、residence proof reject、home_cell イベント発行 |
| Identity | KYC / World ID verified update、duplicate key reject、expired result reject、replay reject |
| Category Pool | admin 作成、category 重複 reject、CategoryPoolCreated イベント、非 admin reject |
| Campaign 作成 | finalize と同一 tx で作成、band < min で非作成、revision 更新で非再作成、Category Pool 自動紐付け（mismatch reject）、スナップショット値の固定、床は未確定で初期化 |
| set_floor_census | 署名/family/PCR 検証、event 束縛 mismatch reject、二重設定 reject、max_liability=0 で床なし、Category ÷N・Main ×20% の escrow 額、reserve floor 維持、floor_ratio ≤ 0.5、Day 30 後 reject |
| claim（床払い経路） | 未センサス reject、未検証 reject、二重受取 reject、固定額どおりの支払い、返還後 reject、owner 宛 transfer、予算非枯渇 |
| return_floor_budget | Day 30 前 reject、按分返還（Category : Main）、端数処理、二重返還 reject、返還後の床払い経路不可 |
| Donation | Campaign / Category 90/5/5・指定なし 95/5 split、端数処理、zero amount reject、ops cap 超過振替（Campaign のみ）、Category / 指定なしへの cap 非適用、期限後 Main ルーティング、寄付は balance に入り floor_balance に入らない、DonationSplit イベント内容 |
| claim（初回経路） | cutoff 2種 reject、affected cell mismatch reject、band too low reject、期限後 reject、leaf 必須、重複申請 reject |
| claim（本人確認） | identity 未確認 reject、duplicate key 他 SBT reject、verified_in_round 記録 |
| lazy finalize | `min(base, 3.0)`、補填なし（Category/Main 不要）、liability=0、実行時刻 guard、Round 2 以降の再分配 |
| claim（本払い経路） | 保存値どおりの支払い（Campaign のみ）、round 単位二重受取 reject、verified_in_round guard、excluded reject、owner 宛 transfer、ENothingToClaim |
| ラウンド継続 | Round 2 で残高再分配、遅延 verify 者の参加、除外の次ラウンド反映 |
| sweep | 終了閾値判定（sweep_eligible）、タイムアウト回収（Case B）、タイムアウト前 reject、床予算返還後のみ可、全額 Main 移送（Category へ流さない）、closed 後の操作 reject |
| Ops | spend イベント記録、残高超過 reject、Main / Category / Campaign からの運営引き出し関数の不存在 |
| 可視化 | total_donated / verified_count_by_band / floor_amount_by_band / total_paid / Category 流入・床拠出累計が正しく更新され、削除済み集計はイベントから復元できる |
| Admin | unauthorized reject、期間短縮 reject、floor_ratio 手動設定不可、pause 中の各操作 reject |
| Version | version 不一致 abort、migrate の単調増加 |

## 16. 開発・検証ポリシー

守る境界:

- Worker / watcher は候補検出と queue 管理を行う。
- Nautilus / verifier は外部 source の再取得と検証を行う。
- **census worker は対象地域の登録者数を集計し署名する（#296）。オンチェーンは署名を検証するだけ。**
- Relayer は finalized payload / 署名済みセンサスを配送するだけにする。
- Move contract は署名済み result と on-chain state だけを信頼する。

検証コマンド:

```bash
# Move source を変更した PR は必ず実行
pnpm check:move

# TypeScript shared contract を変更した PR は必ず実行
pnpm check:ts
```

docs-only PR でも、旧仕様語（50/50 split、Operations Donation、固定支払額、
CampaignBudget、即時支払い、補填を Round 1 に畳み込む方式）が
target 仕様として残っていないことを確認する。

## 17. フェーズ分け

### 17.1 MVP（本書の実装対象）

- `MainPool` / `OperationsPool` / `CategoryPool`（earthquake のみ）/ `Campaign`（床 escrow + 本払い統合）と version ガード
- 寄付3種（90/5/5・95/5、ops cap、期限後 Main ルーティング）と `DonationSplit`
- DisasterEvent finalize と同一 tx での Campaign 自動作成（band 条件 + Category Pool 自動紐付け）
- **後置センサス受理 `set_floor_census` → 床予算 escrow（Category ÷5 → Main ×20%, reserve floor）→ floor_ratio 固定**
- **受給単一入口 `claim`（初回申請＋本人確認＋床払い＋本払いを内包、lazy finalize）**
- 床払いは `claim` の床払い経路（`return_floor_budget` 実行まで、固定額）/ `return_floor_budget`（Day 30 以降）
- 本払いは Campaign 残のみで按分（補填なし、Round 1 + 90日ごと再分配）。確定は `claim` 内 lazy finalize
- `sweep_residual`（Main へのみ）/ `exclude_recipient` / `extend_donation_period` / `spend_operations` / `create_category_pool`
- `metadata_verifier` に census family（= 5）を追加
- `home_cell` 登録/変更のイベント化（#296 indexer 前提）
- リアルタイム表示用フィールド
- 対応通貨は USDC のみ

### 17.2 将来拡張（MVP に含めない）

| 項目 | 概要 |
| --- | --- |
| Category Pool の種別追加（洪水・台風） | verifier 追加と対で admin が `create_category_pool` |
| 非災害 Program（学生支援等） | 受け皿は Category Pool 基盤、受給/支払いは別 Program |
| センサスのオンチェーン補助インデックス | register 時の cell→count DF。集計の主役にはならないが census 入力を軽量化 |
| Matching Pledge / チャレンジ期間 / ラウンド自動実行（keeper bounty） | Campaign の dynamic field・遅延ウィンドウ・実行インセンティブ |
| 複数通貨対応 / 地域係数 / grace period | pools generic 化 / band × 地域係数 / 居住セル変更 cutoff 厳格化 |

## 18. Open Questions

| # | 論点 | 推奨案 |
| --- | --- | --- |
| OQ-1 | reserve floor の絶対額 | 100,000 USDC（`MAIN_RESERVE_FLOOR_USDC`）。中規模災害1件（1,000人 × Band2 150 USDC ≒ 150k）の概ね 2/3 を常時下支え。migrate で調整 |
| OQ-2 | `CATEGORY_ANNUAL_EVENT_DIVISOR = 5` の較正 | finalize 条件（severity_band ≥ MIN_CLAIM_BAND）を満たす地震の年間頻度を USGS 履歴で推定し upgrade で較正。初期は保守的に 5 |
| OQ-3 | **対象地域の登録者数の供給方式（TEE / contract）** | **後置センサス（off-chain 集計→署名→`set_floor_census`、#296）** を採用。純オンチェーン集計は DF 列挙不可・affected cells は root のみ・最大100万セル・cutoff 履歴で不可能。地震 TEE への同梱（全 membership スキャン）は重く密結合のため不採用。署名は census family（#296 で a:運営/census 鍵 vs b:enclave アテステーションを決定） |
| OQ-4 | 床払いの受取期限 | `return_floor_budget`（Day 30 以降）実行までを期限とする。間に合わなかった検証済み者は床を失効（本払いには引き続き参加可）。Day 30 以降は `claim` と `return_floor_budget` のトランザクション順で決まり、返還後は床払い不可 |
| OQ-5 | センサス未到達 / 遅延時の fallback | `census_set == false` のまま Day 30 を迎えたら床払いは行われず本払いのみとなる。off-chain scheduler が finalize 後すぐ census を submit する運用を前提。デッドラインや代替集計は #296 で詰める |
| OQ-6 | 本払いラウンド終了閾値 | `MIN_PAYOUT_PER_RECIPIENT_USDC = 1 USDC` + 絶対額ガード（`campaign_balance < 10 USDC`） |
| OQ-7 | finalize / 返還 / センサス submit の実行者・インセンティブ | permissionless（計算/検証は決定的）+ 運営 off-chain scheduler（既存 AWS runner に cron）。gas bounty は将来 |
| OQ-8 | 検証遅延者のラウンド参加の状態遷移 | `claim` 初回経路で検証した時点の `current_round` を `verified_in_round` に記録し、`claim` 本払い経路は `verified_in_round < current_round` を要求。現行パラメータでは `claim_end_ms < donation_end_ms` のため Round 1 以降に新規検証者は増えないが、guard はラウンド確定前に検証済みの者だけを支払い対象にする不変条件として維持する |
| OQ-9 | 除外の遡及範囲 | 確定済みラウンドの `band_payout` は再計算しない。除外者の未受取分は次ラウンドで全員へ再分配。確定値の不変性（早い者勝ち排除）を優先 |
| OQ-10 | DisasterEvent revision 更新時の Campaign | 作り直さない（最初の Campaign を維持）。revision で対象が広がるケースの救済は別 issue |
| OQ-11 | severity_band を affected cells 最大 band の代理にしてよいか | verifier 仕様（`schemas/`）で `severity_band == max(cell_band)` を明文化。将来 band 別セル数を payload に持つ場合は oracle_version を上げる |

## 19. 関連文書

| 文書 | 内容 |
| --- | --- |
| **GitHub issue #296** | 後置センサス（対象地域の災害前登録メンバー数の off-chain 集計→署名→on-chain 投入）の実装 |
| [docs/donation_flow.md](../donation_flow.md) | 寄付者・受給者向けの公開ガイド（床払い = 最低ラインの支援金 / 本払い = 寄付の分配） |
| `schemas/` | Payload・Merkle leaf・manifest・**センサス result** の言語横断契約 |
