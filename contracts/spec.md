# Sonari Sui Contracts 要件定義

## 読み方ガイド

この文書は Sonari Sui Contracts の実装要件を、単一ファイルのまま次の順序で整理する。

1. **Overview**: 目的、完成状態、MVP / Future 境界、絶対に守る制約。
2. **Business Rules**: Pool、Donation、Membership、PayoutPolicy、EventBudget、Claim 支払い。
3. **On-chain Design**: module、Object、entry 関数、events。
4. **Validation & Security**: Oracle payload、Claim proof、payout 計算順序、security 要件。
5. **Integration & Acceptance**: dapp 連携、test 要件、directory 方針、提出完了条件。

実装時は、まず Overview の完成状態と非保険制約を確認し、次に Business Rules の支払い・資金分離ルールを正として実装する。On-chain Design は構成案、Validation & Security は検証順序と拒否条件、Integration & Acceptance は提出前の確認観点として読む。

## 1. Overview

### 1.1 目的

Sonari Sui Contracts は、Sonari の寄付型 Programmable Payment Platform を mainnet 上で実現するための Sui Move package である。

Sonari は保険商品ではない。支払い保証をしない。寄付金と会員登録費をもとに、災害条件、対象地域、会員状態、不正リスク、Pool 残高、PayoutPolicy に基づいて支援金を支払う。

Contracts は以下を実現する。

| 領域 | 実現すること |
| --- | --- |
| Oracle | Nautilus / TEE が検証した災害イベントをオンチェーンに登録する |
| Pool | Main Pool、Designated Relief Pool、Operations Pool を分離して管理する |
| Donation | General Donation と Designated Donation の配分ルールを実装する |
| Membership | 事前登録済み会員の MembershipPass を管理する |
| Payout | 災害時に PayoutPolicy に基づいて支払額を計算する |
| Budget | Designated Pool 優先、Main Pool 補填、不足時は Claim ごとに cap または支払い不可の流れを実装する |
| Claim | Claim proof により対象地域・会員条件・不正リスク条件を確認し、二重 Claim を防ぐ |
| Transparency | 支払い履歴と寄付履歴を透明化する |
| dapp | 寄付、登録、Claim、Pool 状況確認を実行できるようにする |

### 1.2 ハッカソン完成状態

ハッカソン終了時点では、Sui mainnet 上で以下が動作している状態を完成品とする。

| 分類 | mainnet で動く必要があるもの |
| --- | --- |
| Deployment | Sui mainnet に contracts package が publish されている |
| Oracle | Oracle Registry が初期化され、許可済み Oracle public key が登録されている |
| Oracle | Nautilus / TEE 由来の署名済み finalized payload を受理し、DisasterEvent を作成できる |
| Pool | Main Pool に General Donation を入金できる |
| Pool | Designated Relief Pool に Designated Donation の一部を入金できる |
| Pool | Designated Donation の残りを Main Pool に入金できる |
| Pool | Operations Pool を Main / Relief Pool と分離して管理できる |
| Membership | MembershipPass を発行できる |
| Membership | Verification Fee を Operations Pool に入金できる |
| Claim | Claim 時に MembershipPass、災害対象地域、risk tier、Merkle proof を検証できる |
| Payout | PayoutPolicy に基づいて target_amount を計算できる |
| Budget | EventBudget に基づいて支払い可能額を制限できる |
| Budget | EventBudget不足時は Claim ごとに支払い額を remaining budget 内へ cap する、または支払い不可にできる |
| Claim | Claim 済み記録を保存し、二重 Claim を拒否できる |
| Payout | Claim 成功時に Pool から Relief Cash を支払える |
| dapp | Donation / Claim / Pool / DisasterEvent の状態を dapp から読める |

### 1.3 mainnet で安全側に制限するもの

以下は全章に優先する制約である。

- 支払い保証をしない
- 保険料、掛け金という扱いをしない
- Verification Fee は保険料ではなく、不正対策・検証・運営費として扱う
- Operations Pool と Relief Pool を混同しない
- Designated Pool 同士の流用はしない
- Designated Pool 不足時のみ Main Pool で補填する
- Main Pool は1イベントで使い切らない
- emergency pause を実装する
- Oracle submit、donation、claim、payout を pause 可能にする
- 実資金運用の DeFi 連携は MVP では行わない

### 1.4 MVP / Future 境界

| 区分 | 扱い |
| --- | --- |
| MVP | Earthquake Pool を最優先で扱う |
| MVP | Main Pool、Designated Relief Pool、Operations Pool を明示的に分離する |
| MVP | Designated Pool 優先 + Main Pool 補填まで実装する |
| MVP | EventBudget 上限内で Claim ごとに支払う |
| MVP | EventBudget不足時は payout を remaining budget 内に cap する、または支払い不可にする |
| MVP | 実資金運用は行わず、strategy 表示と dashboard 表示に留める |
| Future | Strict Designated Donation |
| Future | Flexible Relief |
| Future | Emergency Override |
| Future | SUI staking 実運用 |
| Future | Scallop stablecoin strategy 実運用 |
| Future | 複数災害タイプの本番運用 |
| Future | 複雑な本人確認 |
| Future | 法定寄付領収書 |
| Future | fiat 決済 |
| Future | DAO governance |
| Future | 複数 Oracle quorum |
| Future | 高度な不正検知 |
| Future | 全対象者 target_amount 合計に基づく pro-rata / dynamic_payout_factor |

### 1.5 基本方針

Sonari Contracts は以下の方針に従う。

- 保険ではなく寄付型支援インフラとして設計する
- 支払い保証をしない
- 支払いは Pool 残高と PayoutPolicy に依存する
- 会員登録費は Verification Fee として扱う
- 寄付金の流れを透明化する
- Relief Pool と Operations Pool を分離する
- 災害時は Designated Pool を優先する
- Designated Pool 不足時のみ Main Pool で補填する
- それでも不足する場合は Claim ごとに remaining budget 内へ cap する、または支払い不可にする
- Nautilus / TEE は災害条件と対象地域を検証する
- Move はオンチェーン状態、署名、Merkle proof、PayoutPolicy、Pool 残高を検証する
- dapp は表示と transaction 作成を担うが、信用しない

## 2. Business Rules

### 2.1 Pool 構成

| Pool | 用途 | 原資 | MVP での扱い |
| --- | --- | --- | --- |
| Main Pool | 用途を限定しない共通支援プール。General Donation の受け皿、Designated Pool 不足時の補填、予測できない災害への支援、Sonari 全体の緊急流動性。 | General Donation、Designated Donation の一部 | Sonari の中心となる支援原資。災害種別を限定しない。 |
| Designated Relief Pool | 災害種別、地域、企業キャンペーンなど、用途を指定した支援プール。 | Designated Donation の一部 | Oracle 実装済みの Earthquake Pool を最優先で扱う。該当災害が起きた場合、まず対応する Designated Pool から支払う。 |
| Operations Pool | 運営費用のためのプール。Nautilus / TEE 実行費、Cloudflare Worker / D1 / Queue 費用、AWS runner 費用、サーバー、監視、通知、サポート、セキュリティ、監査、保守費に使う。 | Verification Fee、Main Pool Yield Reserve の利回り、明示的な運営支援寄付、将来的な Platform Sponsorship | Relief Pool と明示的に分離する。外部 DeFi や実ステーキングによる利回り連携は行わない。 |

Designated Relief Pool の例:

- Earthquake Pool
- Flood Pool
- Typhoon Pool
- Region Pool
- Sponsor Campaign Pool

### 2.2 Donation 配分ルール

| Donation | 意味 | 配分 | 要件 |
| --- | --- | --- | --- |
| General Donation | 用途指定のない寄付 | 100% Main Pool | amount > 0。Main Pool へ入金。GeneralDonationReceived event を emit。donor 別・Pool 別に透明化できる。 |
| Designated Donation | 企業や個人が、災害種別、地域、キャンペーンなどを指定して行う寄付 | 50% Designated Relief Pool、50% Main Pool | amount > 0。designated target が有効。designated pool が存在する。DesignatedDonationReceived event を emit。Sponsor / donor 別に内訳を表示できる。 |
| Operations Donation | 運営支援目的の寄付 | 100% Operations Pool | 明示的に運営費支援として寄付されたもの。Relief Pool とは分離する。 |

MVP では Strict Designated Donation は実装しない。将来、100% Designated Pool へ入れる選択肢を追加できる構造にする。

### 2.3 Main Pool 運用ルール

MVP では実資金運用は行わないが、PoolPolicy として以下の概念を定義できる状態にする。

| 概念 | ルール | 用途 / 方針 |
| --- | --- | --- |
| Liquid Relief Reserve | Main Pool の最低 70% を即時支払い用に保持する | 災害時の即時支払い、Designated Pool 不足時の補填、予測できない災害への対応 |
| Yield Reserve | Main Pool の最大 30% を運用枠として設計上扱う | 最大 15% SUI Native Staking Reserve、最大 15% Scallop Stablecoin Strategy |
| Future Disaster Reserve | 災害1回で Main Pool を使い切らないための最低残高 | Main Pool total の最低 50% は残す。1イベントで Main Pool から補填できる上限を設定する。大規模災害時でも Pool 全体を空にしない。 |

Yield Reserve の MVP 方針:

- 実資金運用は行わない
- strategy 表示と dashboard 表示に留める
- 利回りがある場合の宛先は Operations Pool とする設計にしておく
- PoolPolicy に ratio や strategy metadata を保持できるようにする

### 2.4 災害時の支払い優先順位

災害発生時は、Nautilus が災害種別、対象地域、重大度を検証し、Move が Pool と PayoutPolicy に基づいて支払う。

支払い優先順位:

1. matching Designated Relief Pool
2. Main Pool backstop
3. 不足時は Claim ごとに remaining budget 内へ cap、または支払い不可

原則:

- Designated Pool 同士の流用はしない
- Earthquake 支援に Flood Pool 資金は使わない
- Main Pool は全体支援原資として補填に使える
- Main Pool にも Future Disaster Reserve を残す

MVP では、Strict / Flexible / Emergency Override の詳細実装は行わず、Designated Pool 優先 + Main Pool 補填まで実装する。

### 2.5 Verification Fee / Membership

Sonari では、ユーザーが災害前に地域と受取 address を登録し、一度きりの Verification Fee を支払う。

Verification Fee の位置づけ:

- 保険料ではない
- 掛け金ではない
- 支援金購入ではない
- 本人性、地域、受取 address、不正リスクを事前検証するための費用
- Operations Pool の原資になる
- 複数アカウント作成への経済的ハードルになる

MembershipPass は、ユーザーの支援対象判定に必要な最小情報を持つ Object である。

| 分類 | 情報 |
| --- | --- |
| オンチェーンに保持する情報 | owner wallet address、payout address、region_id or region_hash、member_since_ms、last_region_change_ms、verification_level、risk_bucket、proof_hash、active flag |
| オンチェーンに出さない情報 | 電話番号、GPS 履歴、端末情報、IP 情報、詳細な本人確認データ |

Claim 対象になるには、以下を満たす必要がある。

- MembershipPass が active
- 災害発生時点で対象地域に登録済み
- 登録から一定期間が経過している
- 地域変更から一定期間が経過している
- risk tier が許容範囲
- Pool に支払い可能残高がある

### 2.6 PayoutPolicy

PayoutPolicy は、支払額を決定するオンチェーン設定 Object である。

基本式:

- target_amount = base_amount_by_band × membership_multiplier × risk_multiplier
- target_amount <= user_max_amount
- target_amount <= policy_max_amount

| 項目 | MVP 値 / ルール |
| --- | --- |
| Base Amount Band 1 | 50 USD 相当 |
| Base Amount Band 2 | 150 USD 相当 |
| Base Amount Band 3 | 300 USD 相当 |
| 登録30日未満 | membership_multiplier = 0 |
| 登録30日以上90日未満 | membership_multiplier = 0.5 |
| 登録90日以上 | membership_multiplier = 1.0 |
| 地域変更から30日未満 | 新地域では 0 |
| Low risk | risk_multiplier = 1.0 |
| Medium risk | risk_multiplier = 0.5 |
| High risk | risk_multiplier = 0 |

PayoutPolicy が保持する情報:

- disaster_type
- base_amount_band_1
- base_amount_band_2
- base_amount_band_3
- partial_membership_days
- full_membership_days
- region_change_cooldown_days
- low_risk_multiplier
- medium_risk_multiplier
- high_risk_multiplier
- user_max_amount
- policy_max_amount
- designated_event_spend_ratio
- main_pool_backstop_ratio
- future_disaster_reserve_ratio
- active flag

MVP では USD 相当額を安定通貨単位で扱う想定にする。SUI 価格変動を避けるため、支援金の中心は USDC などの stable coin を前提とする。ただし、ハッカソン demo で SUI を使う場合は、デモ用 Coin として扱う。

### 2.7 EventBudget

1つの災害イベントで使える予算を EventBudget として計算する。

| 項目 | MVP ルール |
| --- | --- |
| matching Designated Pool | 1イベントで最大 80% まで使用可能 |
| Main Pool Liquid Relief Reserve | 1イベントで最大 20% まで補填可能 |
| Main Pool total | 最低 50% は Future Disaster Reserve として残す |

MVP 計算式:

- future_reserve_floor = main_pool_total × 50%
- liquid_reserve_target = main_pool_total × 70%
- main_pool_spendable = max(0, main_pool_total - future_reserve_floor)
- main_backstop_budget = min(liquid_reserve_target × 20%, main_pool_spendable)
- designated_budget = matching_designated_pool_balance × 80%
- event_budget = designated_budget + main_backstop_budget

実装方針:

- 完全な一括按分は対象者総数を事前に知る必要がある
- ハッカソン MVP では EventBudget Object を作成し、budget cap、claimed amount、remaining amount を管理する
- MVP では EventBudget 上限内で Claim ごとに支払う
- EventBudget不足時は payout を remaining budget 内に cap する、または支払い不可にする
- 全対象者 target_amount 合計に基づく pro-rata は Future 扱いにする
- Future では全対象者 target_amount 合計を集計し、dynamic_payout_factor で比例配分する
- ただし、Pool を使い切らない上限管理は必須

### 2.8 Claim 支払いロジック

Claim 時に以下を検証する。

| 分類 | 条件 |
| --- | --- |
| Disaster 条件 | DisasterEvent が存在する。DisasterEvent.status == FINALIZED。Campaign または Pool が対象災害種別に対応している。Claim 対象の h3_index が affected_cells_root に含まれる。 |
| Membership 条件 | MembershipPass が存在する。MembershipPass.active == true。MembershipPass.owner == claimant。MembershipPass.region_id または region_hash が claim 対象地域に対応する。member_since_ms が災害発生時点より十分前。last_region_change_ms が cooldown 条件を満たす。risk_bucket が許容範囲。 |
| Proof 条件 | AffectedCellLeaf を検証する。Merkle proof が DisasterEvent.affected_cells_root に一致する。leaf.event_uid == DisasterEvent.event_uid。leaf.event_revision == DisasterEvent.event_revision。leaf.h3_index == claimed h3_index。leaf.cell_band >= DisasterEvent.min_claim_band。 |
| 支払額計算 | base amount を cell_band から決める。membership multiplier を MembershipPass から決める。risk multiplier を risk_bucket から決める。user_max_amount を超えない。policy_max_amount を超えない。EventBudget remaining を超えない。EventBudget不足時は remaining budget 内へ cap、または支払い不可にする。Pool 残高を超えない。 |
| Pool 支払い順序 | matching Designated Pool から先に支払う。不足分を Main Pool backstop から支払う。Main Pool の Future Disaster Reserve を侵さない。支払い後に Pool 残高、EventBudget、Claim 記録を更新する。 |

## 3. On-chain Design

### 3.1 Module 構成

完成品では以下の module 構成を目指す。

| Module | 責務 |
| --- | --- |
| admin | AdminCap、pause / unpause、emergency controls、admin-only operations |
| oracle_registry | Oracle public key 管理、finalized payload submit 許可、event_uid 重複管理、pause 管理 |
| payload_v1 | Disaster Oracle Payload v1 struct、BCS decode、validation |
| disaster_event | DisasterEvent Object、DisasterEventCreated event、affected_cells_root 保存 |
| membership | MembershipPass、Verification Fee 受領、region 登録、region 変更、risk bucket 更新、MembershipRegistered event |
| pools | Main Pool、Designated Relief Pool、Operations Pool、PoolPolicy、deposit / withdraw controls、reserve ratio 管理 |
| donation | General Donation、Designated Donation、Operations Donation、donation 配分、DonationReceived event |
| payout_policy | PayoutPolicy Object、band 別 base amount、membership multiplier、risk multiplier、EventBudget rule |
| claim | Claim verification、AffectedCellLeaf proof、payout execution、ClaimReceipt、duplicate claim prevention |
| affected_cell | AffectedCellLeaf、leaf hash、Merkle proof verification |

### 3.2 Object 設計

| Object | 保持する情報 / 用途 |
| --- | --- |
| AdminCap | Registry 初期化、Oracle key 管理、Pool 作成、PayoutPolicy 作成、pause / unpause、emergency control の管理者権限 |
| OracleRegistry | registered oracle keys、disabled oracle keys、accepted event_uid index、supported oracle version、supported hazard type、paused flag |
| DisasterEvent | event_uid、event_revision、hazard_type、severity_band、affected_cells_root、affected_cells_uri、affected_cells_data_hash、raw_data_hash、raw_data_uri、source_set_hash、min_claim_band、occurred_at_ms、observed_at_ms、source_updated_at_ms、geo_resolution、cells_generation_method、cell_metric、cell_aggregation、intensity_scale、max_cell_band、affected_cell_count、created_at_ms |
| MembershipPass | owner、payout_address、region_hash、member_since_ms、last_region_change_ms、verification_level、risk_bucket、proof_hash、active |
| MainPool | balance、liquid_reserve_amount、yield_reserve_amount、operations_yield_amount、total_received、total_paid、total_backstop_paid、paused |
| DesignatedReliefPool | pool_type、region_hash optional、sponsor optional、balance、total_received、total_paid、event_spend_ratio、paused |
| OperationsPool | balance、total_received、total_spent、spending_category summary optional |
| EventBudget | event_uid、designated_pool_id、main_pool_id、designated_budget、main_backstop_budget、total_budget、total_claimed、remaining_budget、active |
| ClaimReceipt | claimant、event_uid、h3_index、cell_band、amount、paid_from_designated、paid_from_main、claimed_at_ms |
| DonationReceipt or Donation event | donor、donation_type、destination pool、amount、split amount、timestamp |

DisasterEvent は Payload v1 の主要フィールドを原則として保存する。実装上保存しないフィールドがある場合は、検証のみ行う理由を module comment または README で明記する。

MainPool は MVP では実 yield 運用を行わず、strategy ratio 表示用の metadata を保持するだけでもよい。

### 3.3 Entry 関数

| Entry | 処理概要 |
| --- | --- |
| initialize | AdminCap、OracleRegistry、MainPool、OperationsPool、default PayoutPolicy を作成する |
| add_oracle_key | Oracle key を追加する |
| disable_oracle_key | Oracle key を無効化する |
| submit_finalized_payload_v1 | Nautilus / TEE 署名済み payload を受理し、DisasterEvent を作成する |
| create_designated_pool | Designated Relief Pool を作成する。MVP では Admin のみ |
| register_member | Verification Fee を受け取り、MembershipPass を発行する。fee > 0、Operations Pool へ入金、region_hash / payout address / member_since_ms / risk_bucket 初期値を保存、MembershipRegistered event を emit |
| update_member_region | 地域を変更する。last_region_change_ms を更新し、cooldown により直後の Claim では新地域対象外にし、event を emit |
| donate_general | General Donation。100% Main Pool へ入金し、event を emit |
| donate_designated | Designated Donation。50% Designated Pool、50% Main Pool へ入金し、event を emit |
| donate_operations | Operations Donation。100% Operations Pool へ入金し、event を emit |
| open_event_budget | DisasterEvent、matching Designated Pool、Main Pool を参照し、budget cap を計算して EventBudget を作成する。MVP では Admin または自動 entry のどちらでもよい |
| claim_relief | DisasterEvent、EventBudget、MembershipPass、AffectedCellLeaf / Merkle proof を検証し、PayoutPolicy に基づく target amount を計算する。Designated Pool から支払い、不足分を Main Pool から支払い、EventBudget 更新、ClaimReceipt 作成、ClaimPaid event emit を行う |
| pause | admin-only。oracle、donations、claims、payouts、specific pool を対象にする |
| close_pool_or_campaign | admin-only。MVP では Pool の pause / close のみでもよい |

### 3.4 Events

| 分類 | Events |
| --- | --- |
| Oracle events | OracleKeyAdded、OracleKeyDisabled、DisasterEventCreated |
| Membership events | MembershipRegistered、MemberRegionUpdated、MembershipRiskUpdated |
| Pool events | MainPoolDeposited、DesignatedPoolDeposited、OperationsPoolDeposited、PoolPaused、EventBudgetOpened |
| Donation events | GeneralDonationReceived、DesignatedDonationReceived、OperationsDonationReceived |
| Claim events | ClaimPaid、ClaimRejected optional、ClaimReceiptCreated |
| Admin events | Paused、Unpaused、PolicyUpdated |

## 4. Validation & Security

### 4.1 Oracle Payload 検証要件

submit_finalized_payload_v1 では以下を検証する。

- registered public key
- valid signature
- valid BCS payload
- intent
- oracle_version
- hazard_type
- status == FINALIZED
- primary_source
- geo_resolution
- cells_generation_method
- cell_metric
- cell_aggregation
- intensity_scale
- min_claim_band
- affected_cell_count > 0
- affected_cells_uri non-empty
- source_set_hash length
- raw_data_hash length
- affected_cells_root length
- affected_cells_data_hash length
- severity_band
- max_cell_band == severity_band
- event_revision > 0
- time ordering
- freshness_deadline_ms
- duplicate event_uid

Move では USGS 取得、ShakeMap 検証、H3 生成、MMI 計算、P90 集約は行わない。

### 4.2 Claim Proof 要件

Claim では以下を検証する。

- AffectedCellLeaf BCS decode
- leaf hash
- Merkle proof
- root == DisasterEvent.affected_cells_root
- event_uid 一致
- event_revision 一致
- h3_index 一致
- geo_resolution 一致
- cell_band >= min_claim_band
- cell_band に応じた base amount 選択

### 4.3 Payout 計算要件

計算順序:

1. cell_band から base_amount を取得
2. membership age から membership_multiplier を取得
3. risk_bucket から risk_multiplier を取得
4. target_amount を計算
5. user_max_amount を適用
6. policy_max_amount を適用
7. EventBudget remaining を適用
8. Pool 残高制約を適用
9. Designated Pool 優先で支払う
10. 不足分を Main Pool から補填する
11. EventBudget不足時は remaining budget 内へ cap、または支払い不可にする

MVP で必須:

- Band 別 base amount
- 会員期間係数
- risk 係数
- Pool 残高制限
- EventBudget 上限
- EventBudget不足時の cap または支払い不可
- 二重 Claim 拒否

MVP で簡略化可能:

- 完全な全対象者按分
- 全対象者 target_amount 合計に基づく dynamic_payout_factor
- 複数段階の後払い調整
- oracle による対象者総数推定

### 4.4 Security 要件

| 区分 | 要件 |
| --- | --- |
| must | 支払い保証をしない設計にする |
| must | Pool 残高以上を支払わない |
| must | EventBudget 以上を支払わない |
| must | Main Pool の Future Disaster Reserve を侵さない |
| must | Designated Pool 同士を流用しない |
| must | Operations Pool と Relief Pool を混同しない |
| must | Verification Fee を Relief payout 原資として扱わない |
| must | Relayer を信用しない |
| must | dapp 入力を信用しない |
| must | Claim の二重支払いを拒否する |
| must | unregistered Oracle key を拒否する |
| must | invalid signature を拒否する |
| must | invalid Merkle proof を拒否する |
| must | admin-only 操作を AdminCap で制限する |
| must | pause 機構を持つ |
| should | Pool と Donation の event を充実させる |
| should | Dashboard で透明化しやすい Object 設計にする |
| should | Sponsor 別寄付額を追えるようにする |
| should | Operations Pool の流入を明示する |
| should | Future Disaster Reserve を表示できるようにする |
| must not | 保険料や掛け金として扱う |
| must not | 支払い保証を示唆する |
| must not | 外部 API を Move から呼ぶ |
| must not | GPS や電話番号などの生データをオンチェーンに出す |
| must not | offchain D1 state を信用する |
| must not | Designated Pool を無関係災害へ流用する |
| must not | paused 中に Claim payout を許可する |

## 5. Integration & Acceptance

### 5.1 dapp 連携要件

dapp から以下を実行できる必要がある。

| 分類 | 要件 |
| --- | --- |
| User-facing | Wallet connect、Membership registration、Verification Fee payment、region registration、Main Pool donation、Designated Pool donation、Pool status view、DisasterEvent view、Claim eligibility check、Claim transaction、Claim history、Donation history |
| Admin-facing | Oracle key management、Pool creation、PayoutPolicy update、EventBudget open、pause / unpause、Pool status monitoring |
| Dashboard | Main Pool 残高、Designated Pool 別残高、Operations Pool 残高、donation split、total paid、EventBudget、future disaster reserve、claim count、sponsor contribution |

### 5.2 Test 要件

| Test カテゴリ | 主要ケース |
| --- | --- |
| Oracle tests | valid payload submit、invalid signature reject、unregistered key reject、expired payload reject、duplicate event reject |
| Membership tests | register member、fee goes to Operations Pool、region update、membership age multiplier、region cooldown |
| Donation tests | general donation goes 100% Main Pool、designated donation splits 50/50、operations donation goes 100% Operations Pool、zero amount reject、paused donation reject |
| Pool tests | designated pool payment priority、main pool backstop、future reserve protected、EventBudget cap、insufficient balance handling |
| Claim tests | valid claim、invalid Merkle proof reject、non-member reject、too-new member payout zero、medium risk multiplier、high risk reject、duplicate claim reject、payout from designated first、payout fallback to main |
| Admin tests | unauthorized admin reject、pause oracle、pause donation、pause claim、disable oracle key |

### 5.3 Directory 方針

作成する構成:

- contracts/Move.toml
- contracts/sources/admin.move
- contracts/sources/oracle_registry.move
- contracts/sources/payload_v1.move
- contracts/sources/disaster_event.move
- contracts/sources/affected_cell.move
- contracts/sources/membership.move
- contracts/sources/pools.move
- contracts/sources/donation.move
- contracts/sources/payout_policy.move
- contracts/sources/claim.move
- contracts/tests/
- contracts/README.md

実装初期は module を統合してもよいが、完成品では責務を分ける。

### 5.4 ハッカソン提出時の完了条件

- contracts package が mainnet publish 済み
- Oracle Registry 初期化済み
- Main Pool 作成済み
- Operations Pool 作成済み
- Earthquake Designated Pool 作成済み
- PayoutPolicy 作成済み
- Oracle public key 登録済み
- finalized payload から DisasterEvent 作成可能
- General Donation が可能
- Designated Donation が 50/50 で分配される
- Verification Fee で MembershipPass を発行可能
- Claim proof で Relief Cash を受け取れる
- Designated Pool 優先で支払われる
- Main Pool 補填が動作する
- 二重 Claim が拒否される
- Pool 残高と EventBudget を超えて支払われない
- dapp から登録、寄付、イベント確認、Claim が可能
- emergency pause が動作する
- Move tests が通る
- mainnet package id / object id が config 化されている
- README または提出 docs に操作手順がある

## 6. 旧章対応

旧 1-23 章の内容は、次の新構成へ移動した。

| 旧章 | 新しい配置 |
| --- | --- |
| 1. 目的 | 1.1 目的 |
| 2. 完成品の状態 | 1.2 ハッカソン完成状態、1.3 mainnet で安全側に制限するもの、1.4 MVP / Future 境界 |
| 3. 基本方針 | 1.5 基本方針 |
| 4. 資金プール構成 | 2.1 Pool 構成 |
| 5. 寄付の配分ルール | 2.2 Donation 配分ルール |
| 6. Main Pool 運用ルール | 2.3 Main Pool 運用ルール |
| 7. 災害時の支払い優先順位 | 2.4 災害時の支払い優先順位 |
| 8. Verification Fee / Membership | 2.5 Verification Fee / Membership |
| 9. PayoutPolicy | 2.6 PayoutPolicy |
| 10. EventBudget | 2.7 EventBudget |
| 11. Claim 支払いロジック | 2.8 Claim 支払いロジック |
| 12. Module 構成 | 3.1 Module 構成 |
| 13. Object 設計 | 3.2 Object 設計 |
| 14. Entry 関数 | 3.3 Entry 関数 |
| 15. Oracle Payload 検証要件 | 4.1 Oracle Payload 検証要件 |
| 16. Claim Proof 要件 | 4.2 Claim Proof 要件 |
| 17. Payout 計算要件 | 4.3 Payout 計算要件 |
| 18. Events | 3.4 Events |
| 19. Security 要件 | 4.4 Security 要件 |
| 20. dapp 連携要件 | 5.1 dapp 連携要件 |
| 21. Test 要件 | 5.2 Test 要件 |
| 22. Directory 方針 | 5.3 Directory 方針 |
| 23. ハッカソン提出時の完了条件 | 5.4 ハッカソン提出時の完了条件 |
