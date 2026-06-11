# Sonari Sui Contracts 設計仕様書

本書は Sonari Sui Move package（`contracts/`）の**技術的設計の正**である。
ここに記述する内容は target の完成状態であり、実装はこの仕様に合わせる。

- 資金フロー（Pool 構成・寄付分割・ラウンド制支払い・Backstop）は
  [docs/fund_flow_spec.md](../docs/fund_flow_spec.md) の確定設計を正として本書に定義する。
  現行実装とのギャップ分析・移行計画・Open Questions は fund_flow_spec.md を参照する。
- 本人確認・災害イベント検証・Merkle proof などの認証/検証まわりは、
  現行実装をそのまま仕様として記述する（変更しない）。
- 寄付者・受給者向けの平易な説明は [docs/donation_flow.md](../docs/donation_flow.md)、
  事業前提は [docs/business_logic.md](../docs/business_logic.md) を参照する。
- デプロイ・実機検証手順は [smoke.md](smoke.md) を参照する。

## 1. Overview

Sonari contracts は、寄付 Pool、災害 Campaign、Membership SBT、
本人確認 registry、DisasterEvent、Claim / Payout、Receipt を管理する。
災害支援は最初のユースケースであり、汎用の支援基盤として設計する。

Sonari は保険ではない。支払いを保証しない。
DonorPass や Membership SBT は支払い保証を与えない。

受給の基本ルール:

- 災害前に作成され、災害前に居住セルを登録した active な Membership SBT の owner だけが申請できる。
- KYC または World ID で本人確認済みであることが支払い条件である。
- 支払額は早い者勝ちにならない。締切後にラウンド単位で按分確定し、全員が同じ比率で受け取る。

## 2. 設計原則

1. **Trust boundary**: Move contract は dapp、worker、relayer、storage を信頼しない。
   Nautilus enclave 署名済み payload、on-chain state、SBT owner だけを使って検証する。
2. **No raw PII**: raw KYC data、World ID proof detail、credential 原文、本人確認書類画像、
   住所、電話、GPS 履歴をオンチェーンに保存しない。
3. **作成時スナップショット**: パラメータはモジュール定数として持ち、Campaign 作成時に
   オブジェクトへコピーして固定する。進行中の Campaign のルールは二度と変わらない。
4. **finalize と claim の分離**: 支払額はラウンド finalize で一度だけ計算して保存する。
   claim は保存値を読むだけで、生のプール残高から金額を導出しない。
5. **admin 最小権限**: admin に許す操作は「受給者に不利にならない方向」のみ
   （寄付期間の延長、不正検出時の一時停止、不正受給者の除外、Ops Pool からの支出）。
   金額・split・対象条件を狭める方向の操作、Campaign の任意作成は実装しない。
6. **version ガード**: 全 shared オブジェクトに `version` フィールドを持たせ、
   全 public 関数の先頭で現行バージョン一致を assert する。
7. **自己記述イベント**: 資金が動くたびに、適用された比率・金額・理由をイベントへ記録する。

## 3. モジュール構成

| モジュール | 主な struct | 役割 |
| --- | --- | --- |
| `admin` | `AdminCap`, `PauseState` | genesis 初期化、AdminCap ゲートの管理操作、global / target pause |
| `pools` | `MainPool`, `OperationsPool` | プラットフォーム共通 Pool（version 付き shared）。Campaign Pool は `campaign` が持つ |
| `campaign` | `Campaign`, `ClaimApplication`, `PayoutKey` | 災害ごとの募金箱＋申請＋ラウンド状態の統合オブジェクト |
| `donation` | `DonorRegistry`, `DonorPass`, `DonationRecord` | 寄付受付と分割、寄付者 SBT（tier 付き、記録のみ） |
| `payout` | `PayoutReceipt` | ラウンド finalize・按分計算・claim_payout・sweep |
| `claim_application` | — | submit_claim / verify_claim の検証ロジック（campaign と分割してもよい。実装時の分割粒度は任意） |
| `disaster_event` | `DisasterRegistry`, `DisasterEvent` | enclave 署名済み payload からの DisasterEvent 作成と Campaign 自動作成の起点 |
| `payload` | `Payload` | 地震 oracle payload の BCS decode と finalized 検証 |
| `affected_cell` | `AffectedCellLeaf`, `ProofStep` | affected cells の Merkle proof 検証 |
| `allowed_residence_cell` | `AllowedResidenceCellRegistry` | 許可居住セル allowlist の Merkle root 管理 |
| `membership` | `MembershipRegistry`, `MembershipPass` | Membership SBT の発行・居住セル管理 |
| `identity_registry` | `IdentityRegistry` | KYC / World ID の duplicate key binding と本人確認記録 |
| `identity_result_v1` | `IdentityVerificationResult` | TEE 署名済み本人確認結果の BCS decode と検証 |
| `metadata_verifier` | `VerifierRegistry` | Nautilus enclave の鍵・PCR 管理と署名検証 |
| `accessor` | — | 外部公開エントリーポイント集約（version / pause チェック → 各モジュール委譲） |
| `reader` | — | 読み取り専用ヘルパー |

旧設計の `program`（generic Program / Campaign）、`payout_policy`（`PayoutPolicy` /
`CampaignBudget`）、`DesignatedPool`、`DisasterCampaignBinding` は廃止する。
Campaign が DisasterEvent との紐付け・資金・パラメータ・ラウンド状態を単一オブジェクトで持つ。

user-facing API は `accessor` module に寄せる。entry は薄く保ち、
検証と状態遷移は package 内 helper（`public(package)`）に委譲する。

## 4. Pool 構成と資金の流れ

| Pool | 個数 | 役割 |
| --- | --- | --- |
| Campaign Pool（`Campaign.balance`） | 災害ごとに1つ・自動作成 | 当該災害の受給者への支払い専用 |
| Main Pool | プラットフォームに1つ | 共通支援。寄付不足 Campaign の backstop と sweep 受け皿 |
| Operations Pool | プラットフォームに1つ | 運営費。寄付時に源泉徴収された分だけが入る |

寄付の分割（寄付受領時に atomic に分割。比率は毎回 `DonationSplit` イベントへ記録する）:

```text
指定寄付（Campaign 指定あり）: 90% Campaign / 5% Main / 5% Operations
一般寄付（指定なし）        : 95% Main / 5% Operations
```

- Campaign 単位の運営費受取に絶対額上限 `campaign_ops_cap`（初期値 50,000 USDC）を置く。
  上限到達後は ops 相当分（5%）を Main へ自動ルーティングする。
- 寄付期間（30日）終了後に当該 Campaign へ届いた指定寄付は、Campaign 取り分を
  Main へルーティングする。
- **Main Pool / Campaign Pool から運営宛に引き出す関数は存在させない。**
  Operations Pool からの支出は自由だが、金額・送金先・reason_code を必ずイベント記録する。
- 対応通貨は MVP では Circle Sui USDC のみ（decimals = 6）。

## 5. オブジェクト設計

### 5.1 Campaign（shared、災害ごとに1つ）

```move
public struct Campaign has key {
    id: UID,
    version: u64,

    // DisasterEvent との紐付け（作成時固定）
    disaster_event_id: ID,
    event_uid: vector<u8>,              // 32 bytes
    event_revision: u32,

    // 資金
    balance: Balance<USDC>,
    designated_received_usdc: u64,      // 指定寄付の Campaign 取り分累計（backstop 上限計算用）
    ops_withheld_usdc: u64,             // この Campaign 起点で Ops へ送った累計（ops cap 判定）

    // 作成時スナップショット（以後不変）
    band_target_usdc: vector<u64>,      // [band1, band2, band3]
    round_cap_multiplier: u64,
    min_claim_band: u8,
    designated_split_campaign_bps: u64,
    designated_split_main_bps: u64,
    designated_split_ops_bps: u64,
    campaign_ops_cap_usdc: u64,
    round_interval_ms: u64,
    min_payout_per_recipient_usdc: u64,
    backstop_main_share_bps: u64,
    backstop_designated_match_bps: u64,

    // 締切（作成時に定数から導出。donation_end のみ admin 延長可）
    created_at_ms: u64,
    donation_end_ms: u64,               // created + 30日
    claim_end_ms: u64,                  // created + 21日（変更不可）

    // 申請状態
    applied_count_by_band: vector<u64>,
    verified_count_by_band: vector<u64>,

    // ラウンド状態（最新ラウンドのみ。過去ラウンドは RoundFinalized イベントで追跡）
    current_round: u64,                 // 0 = 未 finalize
    round_finalized_at_ms: u64,
    round_payout_by_band: vector<u64>,  // finalize で確定。claim はこれを読むだけ
    round_backstop_drawn_usdc: u64,     // Main から引く予定の残枠（earmark）
    round_paid_count: u64,
    round_eligible_count: u64,
    closed: bool,                       // residual sweep 済み

    // 運用
    paused: bool,
}
```

dynamic field（`Campaign.id` 配下）:

```move
// 申請レコード: key = pass_lineage_id
public struct ClaimApplication has copy, drop, store {
    band: u8,
    applied_at_ms: u64,
    verified: bool,
    verified_in_round: u64,     // 検証完了時点の current_round。次の finalize から参加
    excluded: bool,
}

// 受取済みフラグ: key = PayoutKey, value = true
public struct PayoutKey has copy, drop, store {
    pass_lineage_id: ID,
    round: u64,
}
```

Sui の package upgrade では struct フィールド追加が不可のため、counter 類・締切・
ラウンド状態は最初から struct に含める。将来の拡張データは dynamic field で持つ。

### 5.2 MainPool（shared、プラットフォームに1つ）

```move
public struct MainPool has key {
    id: UID,
    version: u64,
    balance: Balance<USDC>,
    total_received_usdc: u64,
    total_backstop_paid_usdc: u64,
    total_swept_in_usdc: u64,
    reserve_floor_usdc: u64,         // 補填後も維持すべき絶対額
    earmarked_backstop_usdc: u64,    // finalize 済みで未払いの backstop 予約額
    created_at_ms: u64,
}
```

Main Pool から出る経路は、finalize 済みラウンドの backstop 支払いのみである。

### 5.3 OperationsPool（shared、プラットフォームに1つ）

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

### 5.4 所有モデルまとめ

| オブジェクト | 所有 | version |
| --- | --- | --- |
| `Campaign` / `MainPool` / `OperationsPool` | shared | あり |
| `MembershipRegistry` / `IdentityRegistry` / `VerifierRegistry` / `DisasterRegistry` / `DonorRegistry` / `AllowedResidenceCellRegistry` / `PauseState` | shared | あり（V2 移行時に付与） |
| `MembershipPass` / `DonorPass` / `PayoutReceipt` | owned（owner へ transfer、`has key` only） | 不要 |
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

```move
// disaster_event::create_from_signed_payload の末尾から呼ぶ。public エントリーは作らない
public(package) fun create_campaign(
    disaster_event_id: ID,
    event_uid: vector<u8>,
    event_revision: u32,
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
- モジュール定数の現在値をコピーして Campaign を構築し share する。
  `donation_end_ms = now + DONATION_PERIOD_MS`、`claim_end_ms = now + CLAIM_PERIOD_MS`。
- 同一 `event_uid` の revision 更新（re-finalize）では新 Campaign を作らない
  （`DisasterRegistry` の dynamic field `event_uid → campaign_id` で判定）。
- イベント: `CampaignCreated`（スナップショットした全パラメータ値を含める）。

## 7. Membership SBT（現行実装を仕様とする）

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
  「pass が active・sender が owner・registry record と整合」を
  `assert_current_pass_precheck` で検証する。
- `home_cell` はユーザー自己申告の居住セル。H3 resolution 7 のみを扱い、
  登録・変更時に `AllowedResidenceCellRegistry` の Merkle root に対する proof 検証を必須とする
  （海のみのセル等を排除）。root は admin が作成・更新でき、更新後は旧 proof が無効になる。
- 居住セルは後から変更できる。変更時刻は `Clock` から取得して
  `home_cell_registered_at_ms` に保存する（災害後変更の駆け込み Claim は cutoff 判定で拒否される）。
- 本人確認状態は Membership SBT ではなく `IdentityRegistry` が持つ。

## 8. 本人確認（現行実装を仕様とする）

### 8.1 IdentityRegistry

```move
public struct IdentityRegistry has key { id: UID, version: u64, binding_count: u64 }

// dynamic field: IdentityKey { provider, duplicate_key_hash } → pass_lineage_id
// dynamic field: pass_lineage_id → IdentityVerificationRecord
public struct IdentityVerificationRecord has copy, drop, store {
    owner: address,
    provider_mask: u8,        // KYC = 1, World ID = 2, 両方 = 3
    verified_at_ms: u64,
    expires_at_ms: u64,
    terms_version: u64,
    signed_statement_hash: vector<u8>,
}
```

- provider は MVP では KYC(1) / World ID(2) のみ。
- duplicate key（provider 内一意 hash）が別 SBT に bind 済みなら reject する
  （`EIdentityKeyAlreadyBound`）。同一 provider の再 verify は
  `provider_mask` の replay 検査で reject する（`EIdentityProviderReplay`）。
- KYC と World ID をまたぐ完全な重複排除は MVP 外。代わりに登録時・Claim 時に
  Sui wallet 署名済み同意（`terms_version` + `signed_statement_hash`）を保存する。

### 8.2 署名済み本人確認結果の受理

`accessor::update_identity_verification` は次を行う:

1. `metadata_verifier::assert_enclave_signed_bytes`（identity family）で enclave 署名を検証する。
2. `identity_result_v1::decode_verified` で BCS decode し、intent / verifier_family /
   version / provider / `verified == true` / 時刻整合（expires > issued、expires > now、
   issued の未来 skew ≤ 5分）/ 各 32-byte hash 長を検証する。
3. `registry_id` 一致 → payload の `owner` から membership lineage を解決 →
   `membership_id` 一致 → owner 整合 → record active を検証する。
4. duplicate key を bind し、`IdentityVerificationRecord` を保存・更新する。

### 8.3 metadata_verifier（Nautilus 署名検証基盤）

- `VerifierRegistry` が verifier family（earthquake oracle = 3 / identity = 4）ごとの
  `VerifierConfig`（PCR0/1/2、48 bytes）と `EnclaveInstance`（instance 公開鍵、有効期限）を管理する。
- `assert_enclave_signed_bytes` は config の有効性・PCR 一致・instance 有効期限・
  Ed25519 署名を検証する。
- admin は verifier key / config の追加・PCR 更新・無効化ができる（EIF 更新時の PCR 再登録）。

## 9. Claim / Payout フロー

タイムライン（Campaign 作成 = Day 0）:

```text
Day 0        DisasterEvent finalize + Campaign 自動作成（同一 tx）
Day 0–30     寄付受付（指定寄付 90/5/5）
Day 0–21     submit_claim（受給申請）受付
Day 21–30    verify_claim（本人確認完了）の猶予
Day 30       finalize_round (Round 1) → claim_payout 開始
以後90日ごと  finalize_round (Round 2, 3, ...): 残高を同じルールで再分配
終了時       sweep_residual → 端数のみ Main Pool へ
```

支払額の原則:

```text
Band 目標額: Band1 = 50 / Band2 = 150 / Band3 = 300 USDC（比率 1:3:6、地域係数なし）
ラウンド上限: 目標額 × 3

finalize_round（ラウンドごとに1回だけ実行）:
  liability = Σ ( band別の検証済み対象者数 × band目標額 )
  ratio     = available_budget / liability
  band別支払額 = min( 目標額 × ratio, 目標額 × 3 )
  → Campaign に保存。以後そのラウンド内では不変

claim_payout（受給者ごと）:
  保存済みの band 別支払額を読むだけ。計算しない。
  受取済みフラグ（ラウンド単位）で二重受取を防ぐ。
  受取先は Membership SBT owner の Sui address。
```

本人確認の種類で支給率を変えない（KYC / World ID どちらも満額。unverified は支払い不可）。

### 9.1 submit_claim（受給申請、Day 0–21）

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

検証（business_logic.md §3 のうち本人確認以外をすべて）:

| 分類 | 条件 | abort |
| --- | --- | --- |
| Version / Pause | version 一致、global / target / campaign 非 pause、`closed == false` | `EVersionMismatch` ほか |
| Window | `now < campaign.claim_end_ms` | `EClaimWindowClosed` |
| Disaster | `campaign.disaster_event_id == id(disaster_event)`、leaf の event_uid / revision 一致 | `EDisasterEventMismatch` |
| Area | `AffectedCellLeaf` の Merkle proof が `affected_cells_root` に対して valid | `EInvalidAffectedCellProof` |
| Band | `leaf.cell_band >= campaign.min_claim_band`（スナップショット値） | `EClaimBandTooLow` |
| SBT | active / sender = owner / registry record 整合 | membership 系 |
| Time | `account_created_at_ms < occurred_at_ms`（cutoff = USGS 地震発生時刻） | `EAccountCreatedAfterCutoff` |
| Time | `home_cell_registered_at_ms < occurred_at_ms` | `EHomeCellRegisteredAfterCutoff` |
| Area | `pass.home_cell == leaf.h3_index` | `EResidenceCellMismatch` |
| Duplicate | 同一 `pass_lineage_id` の申請が未登録 | `EDuplicateApplication` |

処理: `ClaimApplication { band, verified: false, ... }` を登録し、
`applied_count_by_band[band] += 1`。イベント `ClaimSubmitted`。

**本人確認はこの段階では要求しない**（検証遅延者を Day 21 で閉め出さないため）。

### 9.2 verify_claim（申請の本人確認完了、期限なし）

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

- 申請が存在し `verified == false` / `excluded == false`。
- `identity_registry::assert_identity_verified`（record 存在・owner 一致・provider bit・有効期限）。
- `identity_registry::assert_duplicate_key_bound_to_pass`（duplicate key がこの SBT に紐づく）。
- 処理: `verified = true`、`verified_in_round = current_round`、
  `verified_count_by_band[band] += 1`。イベント `ClaimVerified`。
- 申請受付は Day 21 で締切済みのため、verify が増えても申請者集合は増えない。
  Round N の finalize 後に verified になった申請者は Round N+1 から参加する。

### 9.3 finalize_round（ラウンド確定、誰でも実行可）

```move
public fun finalize_round(
    pause_state: &PauseState,
    campaign: &mut Campaign,
    main_pool: &mut MainPool,
    clock: &Clock,
    ctx: &mut TxContext,
)
```

- 実行可能時刻: Round 1 は `now >= created_at_ms + DONATION_PERIOD_MS`（Day 30）。
  Round 2 以降は `now >= round_finalized_at_ms + round_interval_ms`。
- 計算（このラウンド内で不変な値を一度だけ計算して保存する）:

```text
liability   = Σ_band ( eligible_count[band] × band_target[band] )
campaign_av = campaign.balance.value()
backstop    = 0
if campaign_av < liability:                        // 不足時のみ。ratio 1.0 までに限定
    shortfall    = liability − campaign_av
    disposable   = max(main.balance − main.reserve_floor_usdc − main.earmarked_backstop_usdc, 0)
    backstop_cap = min( disposable × backstop_main_share_bps / 10_000,
                        campaign.designated_received_usdc × backstop_designated_match_bps / 10_000 )
    backstop     = min(shortfall, backstop_cap)
available   = campaign_av + backstop
band_payout[b] = min( band_target[b] × available / liability,    // u128 演算・切り捨て
                      band_target[b] × round_cap_multiplier )
```

- Backstop は cap 域（ratio > 1.0）への補填には使わない。
- backstop 採用時は `main_pool.earmarked_backstop_usdc += backstop` で予約し、
  他 Campaign の finalize と二重計上しない。
- `liability == 0` の場合は支払額ゼロでラウンドを進める。
- 終了判定: `available / total_eligible_count < min_payout_per_recipient_usdc` の場合は
  finalize せず `sweep_residual` のみ可能な状態とする。
- イベント: `RoundFinalized`、backstop > 0 のとき `BackstopDraw`。

### 9.4 claim_payout（受給者ごとの受取）

```move
public fun claim_payout(
    pause_state: &PauseState,
    campaign: &mut Campaign,
    main_pool: &mut MainPool,
    membership_registry: &MembershipRegistry,
    pass: &MembershipPass,
    ctx: &mut TxContext,
)
```

- assert: `current_round >= 1`、SBT precheck（sender = owner、active）、
  申請が `verified == true` / `excluded == false`、
  `verified_in_round < current_round`（finalize 前に検証済みだった者のみ）、
  `PayoutKey { pass_lineage_id, current_round }` 未登録（`EDuplicatePayout`）。
- 処理:
  1. `amount = round_payout_by_band[band]` を読むだけ。再計算しない。
  2. `PayoutKey` を登録、`round_paid_count += 1`。
  3. **Campaign → Main の順に引き落とす**（Main からは `round_backstop_drawn_usdc` の
     残枠内のみ。引いた分だけ earmark を減算）。
  4. `transfer::public_transfer(coin, pass.owner)`。
  5. `PayoutReceipt`（round 付き owned receipt）を発行。
- イベント: `PayoutClaimed`。

### 9.5 sweep_residual（最終スイープ、誰でも実行可）

- 事前条件: 終了判定を満たす、または `liability == 0` のままラウンド間隔が経過。
- 処理: Campaign 残高全額を Main へ移して `closed = true`、未消化 earmark を解放。
- イベント: `ResidualSweep`。

### 9.6 寄付関数

```move
public fun donate_designated(
    pause_state: &PauseState, campaign: &mut Campaign,
    main_pool: &mut MainPool, ops_pool: &mut OperationsPool,
    coin: Coin<USDC>, clock: &Clock, ctx: &mut TxContext,
)
public fun donate_general(
    pause_state: &PauseState,
    main_pool: &mut MainPool, ops_pool: &mut OperationsPool,
    coin: Coin<USDC>, ctx: &mut TxContext,
)
```

- 額 > 0（`EZeroDonation`）。`campaign.closed == false`。
- 分割は §4 のとおり。端数は Campaign（指定寄付）/ Main（一般寄付）に寄せる。
- ops cap 超過分・寄付期間終了後の Campaign 取り分は Main へ振り替え、
  `DonationSplit` イベントに実額と適用 bps、振替フラグを記録する。
- DonorPass（tier 付き寄付者 SBT、Bronze/Silver/Gold）は記録用として維持する。
  `*_with_pass` 変種で既存 pass への履歴追記を提供する。Claim 権利は与えない。

### 9.7 spend_operations（運営費支出）

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
| `extend_donation_period` | 延長のみ。短縮は abort | `DonationPeriodExtended` |
| `pause_campaign` / `unpause_campaign` | 不正検出時の一時停止 | `Paused` / `Unpaused`（必須） |
| `pause_global` / `pause_target` ほか | 既存 `PauseState` 機構 | `Paused` / `Unpaused` |
| `exclude_recipient` | 不正確定者を**次の finalize から**除外。確定済みラウンドの保存値は変更しない | `RecipientExcluded`（必須） |
| `spend_operations` | Operations Pool のみ | `OpsSpend`（必須） |
| verifier key / config / PCR 管理 | `metadata_verifier` 系（既存） | 各 config イベント |
| `update_allowed_residence_cell_root` | 居住セル allowlist 更新（既存） | `AllowedResidenceCellRootUpdated` |
| `migrate_*` | version 引き上げのみ（§12） | — |

Campaign の任意作成、支払額・split・期間（短縮方向）・対象条件の変更、
Main / Campaign Pool からの引き出しは admin にも**できない**。

`PauseState` は global pause と target pause（campaign / registry / pool 単位）を持ち、
donation / claim / payout / verifier update 系の全エントリーで検査する。

## 11. 定数表

USDC は 6 decimals（1 USDC = 1_000_000 units）。すべて**モジュール定数**として持ち、
Campaign 作成時にスナップショットする。変更は package upgrade で行い、
**次に作成される Campaign から**適用される。

| 定数名 | 型 | 初期値 | 意味 |
| --- | --- | --- | --- |
| `VERSION` | `u64` | `1` | shared オブジェクトの現行バージョン |
| `BAND_1_TARGET_USDC` | `u64` | `50_000_000` | Band 1 目標額 50 USDC |
| `BAND_2_TARGET_USDC` | `u64` | `150_000_000` | Band 2 目標額 150 USDC |
| `BAND_3_TARGET_USDC` | `u64` | `300_000_000` | Band 3 目標額 300 USDC |
| `ROUND_CAP_MULTIPLIER` | `u64` | `3` | ラウンド上限 = 目標額 × 3 |
| `MIN_CLAIM_BAND` | `u8` | `1` | Claim / Campaign 作成の最低 band |
| `DESIGNATED_SPLIT_CAMPAIGN_BPS` | `u64` | `9_000` | 指定寄付 → Campaign 90% |
| `DESIGNATED_SPLIT_MAIN_BPS` | `u64` | `500` | 指定寄付 → Main 5% |
| `DESIGNATED_SPLIT_OPS_BPS` | `u64` | `500` | 指定寄付 → Ops 5% |
| `GENERAL_SPLIT_MAIN_BPS` | `u64` | `9_500` | 一般寄付 → Main 95% |
| `GENERAL_SPLIT_OPS_BPS` | `u64` | `500` | 一般寄付 → Ops 5% |
| `CAMPAIGN_OPS_CAP_USDC` | `u64` | `50_000_000_000` | Campaign 単位 ops 受取上限 50,000 USDC |
| `DONATION_PERIOD_MS` | `u64` | `2_592_000_000` | 寄付受付 30日 |
| `CLAIM_PERIOD_MS` | `u64` | `1_814_400_000` | 申請受付 21日 |
| `ROUND_INTERVAL_MS` | `u64` | `7_776_000_000` | ラウンド間隔 90日 |
| `MIN_PAYOUT_PER_RECIPIENT_USDC` | `u64` | `1_000_000` | ラウンド終了閾値（受給者あたり 1 USDC） |
| `BACKSTOP_MAIN_SHARE_BPS` | `u64` | `2_000` | backstop 上限: Main 可処分 × 20% |
| `BACKSTOP_DESIGNATED_MATCH_BPS` | `u64` | `10_000` | backstop 上限: designated 受領額 × 100% |
| `MAIN_RESERVE_FLOOR_USDC` | `u64` | `100_000_000_000` | Main に常時残す絶対額 100,000 USDC |
| `BPS_DENOMINATOR` | `u64` | `10_000` | bps 計算分母 |

按分計算は `(target as u128) * (available as u128) / (liability as u128)` の
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
- struct フィールドの追加は upgrade では不可。将来の拡張は dynamic field で行う。
- 定数変更 = package upgrade。進行中の Campaign はスナップショット済みのため
  影響を受けない。`CampaignCreated` イベントが適用値を自己記述するため、
  インデクサは定数のバージョン管理を必要としない。
- 現行実装（PayoutPolicy / CampaignBudget / DesignatedPool / 即時支払い claim）からの
  移行手順・残課題は [docs/fund_flow_spec.md](../docs/fund_flow_spec.md) §5・§8 を参照する。

## 13. イベント一覧

| イベント | 発行タイミング | 主なフィールド |
| --- | --- | --- |
| `CampaignCreated` | Campaign 自動作成 | disaster_event_id、event_uid/revision、スナップショット全パラメータ、締切 |
| `DonationSplit` | すべての寄付 | campaign_id(Option)、各 Pool 実額、適用 bps、ops cap 超過振替額、期限後ルーティングフラグ、donor |
| `ClaimSubmitted` | submit_claim | campaign_id、pass_lineage_id、band |
| `ClaimVerified` | verify_claim | campaign_id、pass_lineage_id、band、round |
| `RoundFinalized` | finalize_round | round、liability、campaign_available、backstop_drawn、band_payout[]、eligible_count |
| `BackstopDraw` | finalize_round（backstop > 0） | round、amount、main_disposable、designated_received |
| `PayoutClaimed` | claim_payout | round、pass_lineage_id、band、amount、campaign/main 内訳、recipient |
| `OpsSpend` | spend_operations | amount、recipient、reason_code、actor |
| `RecipientExcluded` | exclude_recipient | pass_lineage_id、reason_code、round、actor |
| `ResidualSweep` | sweep_residual | amount、final_round |
| `DonationPeriodExtended` | extend_donation_period | old_end_ms、new_end_ms |
| `DisasterEventCreated` / `MembershipPassIssued` / `RegistryCreated` / `Paused` / `Unpaused` / `GenesisObjectCreated` / verifier config 系 | 既存どおり | — |

## 14. セキュリティ要件

| 区分 | 要件 |
| --- | --- |
| must | Pool 残高以上を支払わない |
| must | finalize で保存した band 別支払額以上を支払わない（生のプール残高から金額を導出しない） |
| must | Main Pool の reserve floor と earmark を侵さない |
| must | Backstop は ratio 1.0 までに限定し、上限（Main 可処分 × 20%、designated 受領額 × 100%）を超えない |
| must | Operations Pool を Relief payout 原資にしない |
| must | Main / Campaign Pool から運営宛に引き出す関数を持たない |
| must | Ops 支出は金額・送金先・reason_code をイベント記録する |
| must | 寄付は受領時に atomic に分割し、比率をイベント記録する |
| must | Nautilus 署名済み result だけを信頼する |
| must | IdentityRegistry の有効な本人確認記録を payout に要求する |
| must | provider 内 duplicate key を検証する |
| must | Membership SBT owner にだけ支払う |
| must | 同じ campaign / round の二重受取を拒否する |
| must | 全 shared オブジェクトの version を全 public 関数で検証する |
| must | paused 中の donation / claim / payout / verifier update を拒否する |
| must not | raw personal data をオンチェーンに出す |
| must not | dapp、Relayer、Worker input を信用する |
| must not | DonorPass を Claim 権利として扱う |
| must not | admin に支払額・split・対象条件・期間（短縮方向）の変更を許す |

## 15. テスト要件

| Test | 主要ケース |
| --- | --- |
| Membership | SBT issue、active check、duplicate owner reject、residence proof reject |
| Identity | KYC / World ID verified update、duplicate key reject、expired result reject、replay reject |
| Campaign 作成 | finalize と同一 tx で作成、band < min で非作成、revision 更新で非再作成、スナップショット値の固定 |
| Donation | 90/5/5・95/5 split、端数処理、zero amount reject、ops cap 超過振替、期限後 Main ルーティング、DonationSplit イベント内容 |
| submit_claim | cutoff 2種 reject、affected cell mismatch reject、band too low reject、期限後 reject、duplicate application reject |
| verify_claim | 未申請 reject、identity 未確認 reject、duplicate key 他 SBT reject、verified_in_round 記録 |
| finalize_round | 按分計算（不足 / 充足 / cap 到達）、backstop 上限 3種（shortfall / 20% / designated 100%）、reserve floor、earmark、liability=0、実行時刻 guard |
| claim_payout | 保存値どおりの支払い、Campaign → Main の順、round 単位二重受取 reject、verified_in_round guard、excluded reject、owner 宛 transfer |
| ラウンド継続 | Round 2 で残高再分配、遅延 verify 者の参加、除外の次ラウンド反映 |
| sweep | 終了閾値判定、全額 Main 移送、closed 後の操作 reject |
| Ops | spend イベント記録、残高超過 reject、Main / Campaign からの運営引き出し関数の不存在 |
| Admin | unauthorized reject、期間短縮 reject、pause 中の各操作 reject |
| Version | version 不一致 abort、migrate の単調増加 |

## 16. 開発・検証ポリシー

守る境界:

- Worker / watcher は候補検出と queue 管理を行う。
- Nautilus / verifier は外部 source の再取得と検証を行う。
- Relayer は finalized payload を配送するだけにする。
- Move contract は署名済み result と on-chain state だけを信頼する。

検証コマンド:

```bash
# Move source を変更した PR は必ず実行
pnpm check:move

# TypeScript shared contract を変更した PR は必ず実行
pnpm check:ts
```

docs-only PR でも、旧仕様語（50/50 split、Operations Donation、固定支払額、
CampaignBudget、即時支払い）が target 仕様として残っていないことを確認する。

## 17. 関連文書

| 文書 | 内容 |
| --- | --- |
| [docs/fund_flow_spec.md](../docs/fund_flow_spec.md) | 資金フロー設計の根拠・現行実装ギャップ分析（G1–G18）・移行計画・Open Questions・business_logic.md 改訂リスト |
| [docs/donation_flow.md](../docs/donation_flow.md) | 寄付者・受給者向けの公開ガイド |
| [docs/business_logic.md](../docs/business_logic.md) | 事業・資金設計メモ（§3 Claim 条件・§6 duplicate key は本仕様の前提） |
| [docs/tech_stack.md](../docs/tech_stack.md) | モノレポ構成と contracts 方針 |
| [smoke.md](smoke.md) | デプロイ・実機検証 runbook |
| `schemas/` | Payload・Merkle leaf・manifest の言語横断契約 |
