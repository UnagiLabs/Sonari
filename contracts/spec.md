# Sonari Sui Contracts 要件定義

## 1. Overview

Sonari は、Nautilus で受取対象を検証できる汎用寄付プラットフォームである。災害支援は最初のユースケースだが、contracts の中心は災害専用 object ではなく、`Program / Campaign`、`Pool`、`Membership Pass`、`DonorPass`、`Nautilus Verifier Result`、`Eligibility Root / Result`、`Claim / Payout` の汎用基盤に置く。

Sonari は保険商品ではない。支払い保証をしない。Verification Fee は支援金の購入や継続的な掛け金ではなく、検証、Sybil 対策、運営費を支える一度きりの費用であり、Operations Pool に入る。

PR3 / MVP の donation、pool、donor、budget、payout accounting は Circle 公式 Sui USDC 固定で扱う。coin type は `0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC` であり、source では dependency named address `usdc` により `usdc::usdc::USDC` として参照する。金額は USDC の最小単位で保存し、USDC decimals は 6 を前提にする。repository-local の代替 coin は使わない。任意の `Coin<T>` を受け取る generic donation entry、multi-coin accounting、価格換算、swap、asset whitelist、coin type ごとの Pool 分離は MVP では実装しない。

### 1.1 中心概念

| Concept | 役割 |
| --- | --- |
| `Program` | 寄付の目的、検証要件、対象者種別、Pool 方針、Claim 方針を束ねる上位単位。例: Disaster Relief Program、Student Aid Program。 |
| `Campaign` | Program 配下の期間・スポンサー・地域・災害種別などで区切った実行単位。 |
| `Pool` | Main Pool、Designated Relief Pool、Operations Pool、Campaign Pool などの資金管理単位。 |
| `MembershipPass` | 全受取者が必ず持つ準 SBT。受取者の eligibility / Claim 用であり、Pass metadata は Nautilus 署名済み update だけを信頼する。 |
| `DonorPass` | 寄付者が持つ準 SBT。初回寄付時に自動 mint し、寄付者の貢献証明と dapp 表示に使う。Claim 権利や支払い保証は与えない。 |
| `DonationRecord` | `DonorPass` に dynamic field として紐づく寄付履歴。各寄付の最小情報だけを保持し、`DonorPass` 本体は集計情報だけを保持する。 |
| `NautilusVerifierResult` | Nautilus / TEE が生成する署名済み検証結果。Disaster、Residence、Student など verifier family ごとに作る。 |
| `EligibilityRoot` / `EligibilityResult` | Program / Campaign が Claim に使う対象者集合または個別対象判定の抽象化。 |
| `Claim` / `Payout` | Pass、Verifier Result、Pool、PayoutPolicy を検証して支払いを実行し、二重 Claim を防ぐ。 |

`DisasterEvent` は汎用 Claim 基盤そのものではない。Disaster Relief Program のために、災害イベントと `affected_cells_root` を保存する Program 固有 object として扱う。

### 1.2 MVP 完成状態

| 分類 | mainnet で動く必要があるもの |
| --- | --- |
| Deployment | Sui mainnet に contracts package が publish されている |
| Program | Disaster Relief Program と Earthquake Campaign / Pool を作成できる |
| Pool | Main Pool、Designated Relief Pool、Operations Pool を分離して管理できる |
| Donation | General Donation、Designated Donation、Operations Donation を入金できる |
| Donation | 初回寄付時に寄付者へ DonorPass を自動発行できる |
| Donation | 2 回目以降の寄付を既存 DonorPass の DonationRecord として追加できる |
| Donation | DonorPass の集計情報と tier を dapp から読める |
| Membership | 受取者に MembershipPass を発行できる |
| Membership | Pass metadata update は Nautilus 署名済み result のみ受理する |
| Disaster | Nautilus Disaster Oracle の finalized payload から DisasterEvent を作成できる |
| Claim | DisasterEvent の `affected_cells_root` と Pass の `verified_residence_cell` を合成して Claim 対象を判定できる |
| Payout | `PayoutPolicy` と Program / Campaign budget に基づいて Pool から支払える |
| Safety | Pool 残高、CampaignBudget、Main Pool reserve を超えて支払わない |
| dapp | Donation、Registration、Claim、Pool、Program / Campaign 状態を読める |

### 1.3 絶対制約

- 支払い保証をしない
- 保険料、掛け金、補償購入のように扱わない
- Verification Fee を Relief payout 原資として扱わない
- Operations Pool と Relief / Campaign Pool を混同しない
- Designated Pool 同士を無断流用しない
- Main Pool は 1 Campaign / 1 Event で使い切らない
- DonorPass / DonationRecord を Claim 権利や支払い保証として扱わない
- raw email、phone、GPS 履歴、端末情報、住所、学籍番号、本人確認詳細をオンチェーンに出さない
- dapp、Relayer、Worker、offchain DB を信用しない
- emergency pause を実装する
- 実資金運用の DeFi 連携は MVP では行わない

## 2. Business Rules

### 2.1 Pool 構成

| Pool | 用途 | 原資 | MVP 方針 |
| --- | --- | --- | --- |
| Main Pool | 用途を限定しない共通支援プール。Designated Pool 不足時の backstop。 | General Donation、Designated Donation の一部 | Sonari 全体の支援原資。Future Disaster Reserve を残す。 |
| Designated Relief Pool | 災害種別、地域、スポンサー、Campaign など用途指定の支援プール。 | Designated Donation の一部 | Earthquake Pool を最初に扱う。 |
| Campaign Pool | Student Aid など災害以外の Program / Campaign に紐づく Pool。 | Campaign 指定寄付、スポンサー寄付 | docs 上の設計対象。実装は follow-up。 |
| Operations Pool | Nautilus 実行費、TEE / DB / 監視、サポート、監査、保守。 | Verification Fee、Operations Donation、将来の yield | Relief Pool と明示的に分離する。 |

Donation 配分の既存方針は維持する。

```text
General Donation
  -> 100% Main Pool

Designated Donation
  -> 50% Designated Relief Pool or Campaign Pool
  -> 50% Main Pool

Operations Donation
  -> 100% Operations Pool
```

PR3 で実装する Pool はすべて公式 Sui USDC 専用である。`MainPool`、`DesignatedPool`、`OperationsPool` は `Balance<usdc::usdc::USDC>` と累計 USDC 受入額を保持し、USDC 以外の `Coin<T>` を deposit できる public API surface を持たない。Designated Donation の split は `main = amount / 2`、`designated = amount - main` とし、奇数額の端数は Designated / Campaign Pool 側へ寄せる。

### 2.2 Donation / DonorPass

Donation flow は Pool への入金と寄付者向け記録を同じ transaction 境界で扱う。Pool split は既存方針を維持し、`DonorPass` / `DonationRecord` はその結果を寄付者側に記録するための object である。

Donation API は `contracts::accessor` に集約し、USDC 専用の `public fun` として `donate_general_usdc`、`donate_designated_usdc`、`donate_operations_usdc` を提供する。既存 `DonorPass` を更新する API は `donate_general_usdc_with_pass`、`donate_designated_usdc_with_pass`、`donate_operations_usdc_with_pass` とし、いずれも `Coin<usdc::usdc::USDC>` 固定である。この 6 つの user-facing donation API は `public entry` ではなく `accessor.move` の `public fun` として公開する。任意の `Coin<T>` generic donation は提供しない。zero amount は fail-closed で abort する。donation 前に global pause と対象 Pool pause を検証する。

Donation の user-facing callable API は `accessor.move` の薄い入口に限定し、pause check を行ったうえで Pool deposit / event emit、Designated split、first donation の `DonorPass` 発行、with-pass の owner / registry 検証と `DonationRecord` 追加を `donation` module 内の private / `public(package)` helper に委譲する。`admin.move` は `AdminCap` gated な admin-facing API を持ち、Pool 作成、DonorRegistry 作成、emergency pause 操作を担当する。`donation` / `pools` の実装関数と Pool 作成 helper は `public(package)` に留め、test convenience のために production API surface を広げない。generic `Coin<T>` donation surface と Claim / Payout 権利 API は追加しない。

初回寄付時は、寄付者 wallet に `DonorPass` を自動 mint する。2 回目以降の寄付では、既存 `DonorPass` に dynamic field として `DonationRecord` を追加し、`DonorPass` 本体の集計情報を更新する。`DonorPass` は原則 transfer 不可の準 SBT とし、wallet migration は follow-up で扱う。

初回発行は `DonorRegistry` で donor address と `DonorPass` ID を照合し、同じ donor が初回寄付 entry を再利用して複数 pass を mint することを拒否する。2 回目以降の寄付では、渡された `DonorPass` が registry 上の donor address に対応する pass であることを検証する。

`DonorPass` 本体は集計情報だけを保持する。

| Field | 意味 |
| --- | --- |
| `owner` | DonorPass owner wallet |
| `donor_lineage_id` | 将来の wallet migration 後も寄付者系譜を追うための ID |
| `total_donated` | 累計寄付額 |
| `donation_count` | 累計寄付回数 |
| `first_donated_at_ms` | 初回寄付時刻 |
| `last_donated_at_ms` | 直近寄付時刻 |
| `tier` | 累計寄付額または寄付回数に基づく donor tier |

`DonationRecord` は各寄付の最小情報だけを保持する。

| Field | 意味 |
| --- | --- |
| `donation_index` | DonorPass 内の寄付連番 |
| `donation_type` | General / Designated / Operations などの寄付種別 |
| `program_id` | Program 指定寄付の場合の optional ID |
| `campaign_id` | Campaign 指定寄付の場合の optional ID |
| `pool_id` | 寄付が対象とした Pool |
| `amount` | 寄付額 |
| `coin_type` | 寄付 asset type。PR3 では USDC 固定値のみ |
| `donated_at_ms` | 寄付時刻 |

毎回 `DonationRecorded` event を emit する。初回寄付で `DonorPass` を mint した場合は `DonorPassIssued` event も emit する。累計寄付額または寄付回数により `tier` が変わった場合は `DonorTierUpdated` event を emit する。

PR3 の tier は累計 USDC 寄付額だけで決める。閾値は USDC 最小単位で、`TIER_NONE = 0`、`TIER_BRONZE = 1`、`TIER_SILVER = 2`、`TIER_GOLD = 3` とし、`BRONZE >= 1`、`SILVER >= 1_000_000`、`GOLD >= 10_000_000` を初期値にする。USDC decimals は 6 なので、`1_000_000` は 1 USDC、`10_000_000` は 10 USDC と解釈する。tier が変わった時だけ `DonorTierUpdated` event を emit する。

`DonorPass` / `DonationRecord` は寄付者の貢献証明と dapp 表示用であり、支払い保証、Claim 権利、Pool 優先権、Payout 権利を与えない。raw email、phone、住所、本人確認詳細などの個人情報は保持しない。

### 2.3 Program / Campaign

`Program` は、誰に、どの検証で、どの Pool から、どの上限で支払うかを定義する。

| Field | 意味 |
| --- | --- |
| `program_id` | Program 識別子 |
| `program_type` | `DISASTER_RELIEF`、`STUDENT_AID` など |
| `required_pass_metadata` | Claim に必要な Pass metadata 種別 |
| `required_verifier_family` | `disaster`、`residence`、`student` など |
| `payout_policy_id` | 支払額計算ルール |
| `default_pool_id` | 基本 Pool |
| `status` | `active`、`inactive`、`closed`。business state を表す |

emergency pause は Program / Campaign の `status` とは分離する。
`status` は business lifecycle、`PauseState` は緊急停止として扱い、claim precheck は `status == active`、global pause なし、Program / Campaign target pause なしをすべて満たす場合だけ通す。

`Campaign` は Program 配下の具体的な実行単位である。Disaster Relief では地震イベントやスポンサー単位、Student Aid では学期・学校・スポンサー単位にできる。

### 2.4 Membership Pass

Membership Pass は全受取者に必須の準 SBT である。Pass は通常 transfer できない。wallet 紛失や recovery のための移行は、Nautilus 署名付き migration result を contracts が検証した場合だけ許可する。

Pass は個人情報を直接保持しない。支払い判定に使う metadata は Nautilus 署名済み update のみ信頼する。

| Metadata | 例 |
| --- | --- |
| Core | `pass_lineage_id`、owner、payout address、status、issued_at_ms、last_metadata_update_ms |
| Residence | `verified_residence_cell`、`residence_confidence`、`residence_risk_bucket`、`residence_evidence_snapshot_hash`、`residence_issued_at_ms`、`residence_expires_at_ms`、`residence_last_update_id` |
| Student | `school_region_hash`、`student_status`、`student_confidence`、`student_risk_bucket`、`student_evidence_snapshot_hash`、`student_issued_at_ms`、`student_expires_at_ms`、`student_last_update_id` |

Pass status:

- `active`
- `suspended`
- `revoked`
- `migrated`

`pass_lineage_id` は wallet 移行後も同一人物の Pass 系譜を追うための ID であり、二重 Claim 防止 key に含める。

### 2.5 Nautilus Metadata Update

contracts は verifier family ごとの署名済み result を検証し、Pass metadata を更新する。

```text
ResidenceMetadataUpdateMessage {
  intent
  verifier_family
  verifier_version
  registry_id
  pass_lineage_id
  owner
  update_id
  issued_at_ms
  expires_at_ms
  verified_residence_cell
  residence_confidence
  risk_bucket
  evidence_snapshot_hash
}

StudentMetadataUpdateMessage {
  intent
  verifier_family
  verifier_version
  registry_id
  pass_lineage_id
  owner
  update_id
  issued_at_ms
  expires_at_ms
  school_region_hash
  student_status
  student_confidence
  risk_bucket
  evidence_snapshot_hash
}
```

署名対象は上記 field order の Move struct に対する `sui::bcs::to_bytes(&message)` の bytes で固定する。Residence の `intent` は `SONARI_RESIDENCE_METADATA_UPDATE_V1`、Student の `intent` は `SONARI_STUDENT_METADATA_UPDATE_V1` とし、`verifier_version` は v1 では `1` である。`payout_address` は PR5 の署名対象に含めず、Claim / Payout PR 側で使用可否を検証する。

`VerifierRegistry` は AdminCap gated に作成し、Ed25519 public key、verifier family、version、enabled / disabled 状態を保持する。key registration は family `RESIDENCE` / `STUDENT`、version `V1` のみ許可し、unknown family / version は fail-closed で拒否する。metadata update は registry に登録済みで enabled な key の Ed25519 signature だけを受理する。public key bytes は 32 bytes、signature bytes は 64 bytes でない場合 fail-closed で拒否する。

metadata update の user-facing API は global pause または VerifierRegistry target pause 中に拒否する。一方、AdminCap gated な verifier key add / disable は pause 中も許可する。disable は emergency revoke 用の操作であり、pause 中でも実行できる必要がある。すでに disabled な key の再 disable は拒否し、`VerifierKeyDisabled` event の重複 emit を防ぐ。

freshness は `Clock` の `timestamp_ms` で検証する。`expires_at_ms <= now_ms`、`expires_at_ms <= issued_at_ms`、`issued_at_ms` が `now_ms` より 300,000 ms を超えて未来の場合は拒否する。replay prevention は `pass_lineage_id × verifier_family` 単位で `update_id` を monotonic に扱い、Residence と Student の update_id は別系列として進める。

raw email、phone、GPS 履歴、端末情報、住所、学籍番号、在学証明書の原文はオンチェーンに出さない。オンチェーンには bucket、hash、有効期限、署名検証に必要な最小情報だけを残す。

### 2.6 Web MVP Residence Confidence Scoring

MVP の residence verifier は、ユーザーが Web で提出する複数の低侵襲 signal から confidence score を作る。

例:

- self-declared region
- wallet age / pass age
- coarse check-in history hash
- proof of local interaction hash
- claim 前の residence metadata freshness
- repeated region change risk

Web MVP は raw GPS や詳細住所をオンチェーンに出さない。Nautilus は evidence snapshot を秘匿して検証し、`verified_residence_cell`、`confidence`、`risk_bucket`、`evidence_snapshot_hash` だけを署名する。

### 2.7 Student Aid Model

Student Aid Program は災害以外の汎用寄付ユースケースである。

| 項目 | 方針 |
| --- | --- |
| 対象 | 学生または学校単位の支援対象者 |
| 必須 Pass | `MembershipPass.active == true` |
| 必須 metadata | `StudentMetadataUpdate` による `student_status` と confidence |
| Claim 判定 | Campaign 条件、Pass status、Student metadata freshness、risk bucket |
| Privacy | 学籍番号、学校メール、在学証明書画像、氏名、住所はオンチェーンに出さない |

Student verifier は initial MVP では docs / dummy shared types 中心にし、実データ連携は follow-up とする。

## 3. Claim / Payout

### 3.1 Generic Claim Flow

```mermaid
flowchart TD
  Donor[Donor / Sponsor] --> Pool[Program or Campaign Pool]
  User[Recipient] --> Pass[MembershipPass]
  Verifier[Nautilus Verifier] --> Metadata[Signed Metadata Update]
  Metadata --> Pass
  Program[Program / Campaign] --> Policy[PayoutPolicy]
  Pass --> Claim[Claim]
  Policy --> Claim
  Pool --> Claim
  Claim --> Payout[Payout + Receipt]
```

Generic Claim は以下を検証する。

| 分類 | 条件 |
| --- | --- |
| Program | Program / Campaign が active。Claim window と対象条件を満たす。 |
| Pass | MembershipPass が active。owner または許可済み payout address が一致。`pass_lineage_id` で二重 Claim していない。 |
| Metadata | 必要な Pass metadata が Nautilus 署名済みで、有効期限内。 |
| Eligibility | Program 固有の `EligibilityResult` または root proof が Program 条件に一致。 |
| Payout | `PayoutPolicy`、`eligibility_tier`、risk bucket、CampaignBudget、Pool 残高を超えない。 |

### 3.2 Disaster Claim Composition

Disaster Relief Program の Claim は、Disaster Oracle の root と Membership Pass の residence metadata を合成する。

```mermaid
flowchart LR
  DisasterEvent[DisasterEvent affected_cells_root]
  Leaf[AffectedCellLeaf + Merkle proof]
  Pass[MembershipPass verified_residence_cell]
  Claim[Disaster Claim]
  DisasterEvent --> Leaf --> Claim
  Pass --> Claim
  Claim --> Payout[Relief payout]
```

検証要件:

- `DisasterEvent` は finalized Nautilus payload から作成されている
- `AffectedCellLeaf` と Merkle proof が `affected_cells_root` に一致する
- `leaf.h3_index == MembershipPass.verified_residence_cell`
- `leaf.cell_band >= DisasterEvent.min_claim_band`
- Pass の residence metadata が災害発生時点または Claim window の要件を満たす
- `pass_lineage_id + campaign_id/event_uid` で二重 Claim を拒否する

`AffectedCellLeaf` の canonical order、BCS payload、hash 仕様は `schemas/affected_cell_leaf.md` と Disaster Oracle v1 仕様を維持する。この docs 更新では field order、schema、golden vector を変更しない。

### 3.3 Eligibility Result

```text
EligibilityResult {
  program_id
  campaign_id
  pass_lineage_id
  eligibility_tier
  max_amount
  verifier_family
  result_hash
  issued_at_ms
  expires_at_ms
}
```

`EligibilityLeaf` を使う Campaign では、leaf と Merkle proof により対象者集合に含まれることを検証する。Disaster Relief v1 では `AffectedCellLeaf` が地理的 eligibility leaf の役割を担い、Pass の `verified_residence_cell` と一致させる。

### 3.4 PayoutPolicy

`PayoutPolicy` は Program / Campaign ごとの支払額を定義する。

```text
target_amount =
  base_amount_by_eligibility_tier
  * membership_multiplier
  * confidence_multiplier
  * risk_multiplier
```

適用上限:

- `target_amount <= user_max_amount`
- `target_amount <= policy_max_amount`
- `target_amount <= CampaignBudget.remaining_budget`
- Pool 残高と reserve constraint を超えない

MVP Disaster Relief の既存値:

| 項目 | 値 |
| --- | --- |
| Band 1 | 50 USD 相当 |
| Band 2 | 150 USD 相当 |
| Band 3 | 300 USD 相当 |
| 登録 30 日未満 | multiplier = 0 |
| 登録 30〜90 日 | multiplier = 0.5 |
| 登録 90 日以上 | multiplier = 1.0 |
| Low risk | multiplier = 1.0 |
| Medium risk | multiplier = 0.5 |
| High risk | multiplier = 0 |

### 3.5 ProgramBudget / CampaignBudget

`EventBudget` は Disaster Relief Program 固有名に見えるため、汎用設計では `ProgramBudget` / `CampaignBudget` を使う。Disaster Event の場合は CampaignBudget が EventBudget の役割を持つ。

既存の資金設計は維持する。

```text
future_reserve_floor = main_pool_total * 50%
liquid_reserve_target = main_pool_total * 70%
main_pool_spendable = max(0, main_pool_total - future_reserve_floor)
main_backstop_budget = min(liquid_reserve_target * 20%, main_pool_spendable)
designated_budget = matching_designated_pool_balance * 80%
campaign_budget = designated_budget + main_backstop_budget
```

MVP では全対象者 target amount 合計に基づく完全な pro-rata は Future 扱いにする。CampaignBudget 上限内で Claim ごとに支払い、budget 不足時は remaining budget 内へ cap、または支払い不可にする。

## 4. On-chain Design

### 4.1 Module 構成

| Module | 責務 |
| --- | --- |
| `admin` | AdminCap、pause / unpause、emergency controls |
| `program` | Program / Campaign registry、status、required metadata |
| `pools` | Main Pool、Designated / Campaign Pool、Operations Pool、reserve rule |
| `donation` | General / Designated / Operations Donation と split、DonorPass 発行、DonationRecord 追加、donor 集計 / tier 更新 |
| `donor` (optional) | `donation` から分離する場合の DonorPass / DonationRecord 管理。MVP では donation module 内責務として扱ってよい |
| `membership` | MembershipPass、Pass status、semi-SBT migration |
| `metadata_verifier` | Nautilus verifier key、Residence / Student metadata update 検証 |
| `disaster_event` | Disaster Relief Program 固有の DisasterEvent 保存 |
| `payload_v1` | Disaster Oracle Payload v1 BCS decode / validation |
| `affected_cell` | AffectedCellLeaf、Merkle proof verification |
| `payout_policy` | eligibility tier、risk、confidence、budget rule |
| `claim` | Generic Claim verification、payout execution、receipt、duplicate prevention |

### 4.2 Object 設計

| Object | 保持する情報 / 用途 |
| --- | --- |
| `AdminCap` | 管理者権限 |
| `PauseState` | global pause と target pause 対象の集合。business status とは独立した emergency control |
| `DonorRegistry` | donor address と `DonorPass` ID の対応。初回発行の一意性と既存 pass 更新時の照合に使う |
| `Program` | program type、required metadata、default policy / pool、status |
| `Campaign` | program id、campaign metadata、pool id、claim window、status |
| `MembershipPass` | owner、payout address、`pass_lineage_id`、status、metadata buckets |
| `DonorPass` | owner、`donor_lineage_id`、total donated、donation count、first / last donated timestamp、tier |
| `DonationRecord` | DonorPass dynamic field。donation index、donation type、optional program / campaign、pool、amount、coin type、timestamp |
| `VerifierRegistry` | Nautilus verifier public key、verifier family、disabled flag |
| `MainPool` | USDC balance、USDC total received、将来の reserve / paid 集計 |
| `ProgramPool` / `DesignatedPool` | program / campaign / hazard / sponsor 別 USDC balance |
| `OperationsPool` | verification fee と operations donation の USDC 残高 |
| `PayoutPolicy` | tier amount、multipliers、caps、reserve ratios |
| `CampaignBudget` | designated budget、main backstop budget、claimed、remaining |
| `DisasterEvent` | event uid、revision、hazard type、`affected_cells_root`、data hash、min claim band |
| `ClaimReceipt` | claimant、pass lineage、program / campaign、amount、paid_from、claimed_at |

### 4.3 外部 API 関数

| API | 処理概要 |
| --- | --- |
| `initialize` | AdminCap、registries、default pools / policies を作成 |
| `create_program` / `create_campaign` | Program / Campaign を作成 |
| `admin::create_donor_registry` | `AdminCap` で donor address と DonorPass ID の照合 registry を作成 |
| `admin::pause_global` / `admin::unpause_global` | `AdminCap` で emergency pause を全体に適用 / 解除 |
| `admin::pause_target` / `admin::unpause_target` | `AdminCap` で Program / Campaign / Pool などの target object に emergency pause を適用 / 解除 |
| `admin::create_main_pool` / `admin::create_designated_pool` / `admin::create_operations_pool` | `AdminCap` で USDC Pool を作成 |
| `accessor::donate_general_usdc` | `Coin<usdc::usdc::USDC>` を 100% Main Pool に入金し、初回寄付として DonorPass / DonationRecord / donor 集計を作成する |
| `accessor::donate_general_usdc_with_pass` | 既存 DonorPass を registry と照合し、General USDC DonationRecord と donor 集計を更新する |
| `accessor::donate_designated_usdc` | `Coin<usdc::usdc::USDC>` を Designated / Campaign Pool と Main Pool に 50/50 split し、初回 DonorPass / DonationRecord / donor 集計を作成する |
| `accessor::donate_designated_usdc_with_pass` | 既存 DonorPass を registry と照合し、Designated USDC DonationRecord と donor 集計を更新する |
| `accessor::donate_operations_usdc` | `Coin<usdc::usdc::USDC>` を 100% Operations Pool に入金し、初回 DonorPass / DonationRecord / donor 集計を作成する |
| `accessor::donate_operations_usdc_with_pass` | 既存 DonorPass を registry と照合し、Operations USDC DonationRecord と donor 集計を更新する |
| `accessor::donation_record_summary` | DonorPass dynamic field に保持する DonationRecord の frontend-facing summary を index で返す |
| `register_member` | Verification Fee を Operations Pool に入れ、MembershipPass を発行 |
| `submit_pass_metadata_update` | Nautilus 署名済み Residence / Student metadata update を検証して Pass 更新 |
| `request_pass_migration` | Nautilus 署名済み migration result により Pass owner / payout address を移行 |
| `submit_finalized_disaster_payload_v1` | Disaster Oracle v1 payload を検証して DisasterEvent を作成 |
| `open_campaign_budget` | Program / Campaign / Pool に基づき budget cap を作成 |
| `claim` | Generic Claim。Program 条件、Pass、metadata、eligibility、budget、Pool を検証して支払う |
| `pause` / `unpause` | admin-only emergency control |

### 4.4 Events

| 分類 | Events |
| --- | --- |
| Program | `ProgramCreated`、`CampaignCreated`、`CampaignBudgetOpened` |
| Membership | `MembershipPassIssued`、`PassMetadataUpdated`、`PassMigrated`、`PassStatusUpdated` |
| Verifier | `VerifierKeyAdded`、`VerifierKeyDisabled` |
| Pool / Donation | `PoolCreated`、`GeneralDonationReceived`、`DesignatedDonationReceived`、`OperationsDonationReceived`、`DonationRecorded`、`DonorPassIssued`、`DonorTierUpdated` |
| Disaster | `DisasterEventCreated` |
| Claim | `ClaimPaid`、`ClaimRejected` optional、`ClaimReceiptCreated` |
| Admin | `Paused`、`Unpaused`、`PolicyUpdated` |

## 5. Validation & Security

### 5.1 Nautilus Result 検証

すべての verifier result で以下を検証する。

- registered verifier public key
- valid signature
- verifier family / version
- intent
- freshness / expiry
- pass lineage / owner binding
- replay prevention
- disabled key rejection

Disaster Oracle v1 payload では、既存の `oracle_version = 1`、field order、enum、BCS encoding、`AffectedCellLeaf` hash 仕様を変更しない。

### 5.2 Privacy

オンチェーンに出してよいもの:

- hash
- coarse H3 cell
- confidence / risk bucket
- eligibility tier
- timestamp / expiry
- verifier version

オンチェーンに出してはいけないもの:

- raw email
- phone number
- GPS history
- device id / fingerprint
- IP history
- detailed address
- student id
- school email raw value
- ID document image or text

### 5.3 Security 要件

| 区分 | 要件 |
| --- | --- |
| must | Pool 残高以上を支払わない |
| must | CampaignBudget 以上を支払わない |
| must | Main Pool reserve を侵さない |
| must | Verification Fee を payout 原資にしない |
| must | Pass metadata は Nautilus 署名済み update のみ信頼する |
| must | `pass_lineage_id` で二重 Claim を拒否する |
| must | Donation ごとに `DonationRecorded` を emit する |
| must | DonorPass は通常 transfer を拒否する |
| must | invalid signature / expired result / disabled verifier を拒否する |
| must | paused 中の donation / claim / verifier update を拒否する |
| must not | 支払い保証を示唆する |
| must not | DonorPass / DonationRecord を Claim / Payout 権利として扱う |
| must not | raw personal data をオンチェーンに出す |
| must not | Relayer / dapp / Worker input を信用する |

## 6. Integration & Acceptance

### 6.1 dapp 連携

| 分類 | 要件 |
| --- | --- |
| User | Wallet connect、Membership registration、Pass status view、metadata refresh、Donation、Claim、Claim history |
| Donor / Sponsor | General / Designated / Campaign Donation、DonorPass view、donation history、total donated、donor tier、sponsor contribution view |
| Admin | Program / Campaign / Pool / Verifier key / PayoutPolicy / pause 管理 |
| Dashboard | Main Pool、Designated / Campaign Pool、Operations Pool、budget、claim count、paid amount、sponsor impact |

### 6.2 Test 要件

| Test | 主要ケース |
| --- | --- |
| Program | create program / campaign、inactive reject |
| Membership | issue pass、semi-SBT transfer reject、signed migration accepted、duplicate migration reject |
| Metadata | valid residence / student update、invalid signature reject、expired update reject、disabled verifier reject |
| Donation | `accessor.move` の 6 public donation functions only、`public entry` なし、USDC only、General 100% Main、Designated 50/50、odd remainder to Designated、Operations 100% Operations、zero amount reject、generic `Coin<T>` donation surface なし |
| DonorPass | first donation mints DonorPass、second and later donations append DonationRecord、aggregate fields update、duplicate first-donation mint reject、semi-SBT transfer reject |
| Donor events | DonationRecorded every donation、DonorPassIssued first donation only、DonorTierUpdated only when tier changes |
| Donor safety | DonorPass / DonationRecord do not grant Claim / Payout rights、raw personal data is not stored |
| Pool / Budget | designated priority、main backstop、future reserve protected、budget cap |
| Disaster | valid payload submit、invalid signature reject、duplicate event reject、AffectedCell proof |
| Claim | valid generic claim、valid disaster claim composition、stale metadata reject、duplicate claim reject、high risk reject |
| Admin | unauthorized reject、pause donation / claim / verifier update |

### 6.3 PR3 実装境界

PR3 は公式 Sui USDC fixed accounting の Pool / Donation / DonorPass 基盤を実装する。実コード API と Move type は追加するが、schema、BCS field order、`AffectedCellLeaf` canonical order、golden vector、Disaster Oracle v1 payload は変更しない。USDC asset handling の follow-up は multi-coin donation、価格換算、swap、asset whitelist、coin type ごとの Pool 分離に限定する。Campaign Pool の本実装、Claim / Payout 実行は別ロードマップ PR で扱う。
