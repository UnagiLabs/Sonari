# Sonari Sui Contracts 開発フロー

## 1. 目的

この文書は、Sonari Sui Contracts をハッカソン提出時点で mainnet 上の寄付型 Programmable Payment Platform として機能させるための開発順序を定義する。

Sonari は保険商品ではなく、災害支援のための寄付型インフラである。支払い保証は行わず、Main Pool、Designated Relief Pool、Operations Pool、MembershipPass、DisasterEvent、PayoutPolicy、Claim proof、Pool残高に基づいて支援金を支払う。

Contracts は Nautilus Disaster Oracle の出口であると同時に、寄付・会員登録・支払い・透明性ダッシュボードのオンチェーン基盤である。

## 2. 開発方針

- mainnetで実際に動く完成品を目標にする
- ただし段階的に実装し、各PRで壊れない単位に分割する
- まず資金を動かさない基盤を作る
- 次にPoolとDonationを作る
- その後MembershipとClaimを作る
- 最後にmainnet deployとdapp統合へ進む
- Oracle / Pool / Membership / Claim / Admin の責務を分ける
- 保険・掛け金・支払い保証に見える設計を避ける
- Main Pool、Designated Relief Pool、Operations Poolを明確に分離する
- Verification FeeはOperations Poolへ入れる
- General Donationは100% Main Poolへ入れる
- Designated Donationは50% Designated Relief Pool、50% Main Poolへ入れる
- 災害時はDesignated Pool優先、Main Pool補填、不足時はClaimごとにremaining budget内へcap、または支払い不可にする
- Designated Pool同士の流用はMVPでは行わない
- MoveはRelayer、Worker、dapp、D1、外部APIを信用しない
- Move内でUSGS取得、ShakeMap検証、H3生成、MMI計算、P90集約は行わない
- 実資金運用のSUI staking / Scallop strategyはMVPでは行わず、表示・設計に留める
- emergency pauseを必ず入れる
- dappが読みやすいeventsをemitする

## 3. 全体フェーズ

### Phase 0. Contracts設計docs作成

目的:

- contracts/spec.md
- contracts/devflow.md

を作成し、Codexが実装に入れる状態にする。

完了条件:

- business_logic.mdの資金設計と矛盾しない
- Nautilus Oracle payload仕様と矛盾しない
- ハッカソン完成時のmainnet状態が明確
- PR分割方針が明確

### Phase 1. Contracts scaffold

目的:

- Move packageの土台を作る

実装対象:

- contracts/Move.toml
- contracts/sources/
- contracts/tests/
- contracts/README.md

実装内容:

- 最小module
- build可能なMove package
- test可能な構成
- constantsの仮配置
- README初版

完了条件:

- sui move build が通る
- sui move test が通る
- root既存のpnpm / Rust / Nautilus系チェックを壊さない
- contracts開発に入れる状態になっている

### Phase 2. Admin / Pause 基盤

目的:

- mainnetで資金とOracleを扱うための管理権限と停止機構を作る

実装対象:

- admin module
- AdminCap
- pause / unpause logic
- admin events

実装内容:

- AdminCap作成
- admin-only entry
- pause targetの設計
- oracle submit pause
- donation pause
- claim pause
- payout pause
- pool pause
- unauthorized admin rejection

完了条件:

- AdminCapなしでは管理操作できない
- pause中に対象操作が拒否される
- pause / unpause eventsがemitされる
- unit testsが通る

### Phase 3. Oracle Registry / DisasterEvent 基盤

目的:

- Nautilus / TEE署名済みpayloadを受け取り、DisasterEventを作成できるようにする

実装対象:

- oracle_registry module
- payload_v1 module
- disaster_event module
- OracleRegistry
- DisasterEvent
- Oracle key管理
- submit_finalized_payload_v1

実装内容:

- Oracle public key登録
- Oracle public key無効化
- registered key確認
- disabled key拒否
- Payload v1 BCS decode
- signature verification
- payload validation
- freshness validation
- event_uid重複拒否
- DisasterEvent Object作成
- DisasterEventにPayload v1主要フィールドを保存
- DisasterEventCreated event emit

DisasterEventに保存するPayload v1主要フィールド:

- event_uid
- event_revision
- hazard_type
- severity_band
- affected_cells_root
- affected_cells_uri
- affected_cells_data_hash
- raw_data_hash
- raw_data_uri
- source_set_hash
- min_claim_band
- occurred_at_ms
- observed_at_ms
- source_updated_at_ms
- geo_resolution
- cells_generation_method
- cell_metric
- cell_aggregation
- intensity_scale
- max_cell_band
- affected_cell_count

検証項目:

- valid payload submit
- invalid signature reject
- unregistered key reject
- disabled key reject
- invalid BCS reject
- non-finalized status reject
- wrong oracle_version reject
- wrong hazard_type reject
- expired payload reject
- duplicate event_uid reject

完了条件:

- Nautilus fixture由来のpayloadをMove側で受理できる
- DisasterEventが作成される
- affected_cells_rootが保存される
- raw_data_uri、geo_resolution、observed_at_ms、source_updated_at_msが保存される
- pending / rejected / ignored_small はオンチェーン作成されない
- Move testsが通る

### Phase 4. Pool基盤

目的:

- business_logic.mdに沿った資金プールを実装する

実装対象:

- pools module
- MainPool
- DesignatedReliefPool
- OperationsPool
- PoolPolicy
- pool events

実装内容:

- Main Pool作成
- Operations Pool作成
- Designated Relief Pool作成
- Earthquake Pool作成
- Pool残高管理
- total_received管理
- total_paid管理
- paused管理
- Future Disaster Reserve設定
- Designated Pool event spend ratio設定
- Main Pool backstop ratio設定
- PoolCreated event
- PoolPaused event

MVPで必須のPool:

- Main Pool
- Operations Pool
- Earthquake Designated Relief Pool

MVPでは実装しないもの:

- 実SUI staking
- 実Scallop strategy
- Designated Pool同士の流用
- Emergency Override
- Flexible Relief

完了条件:

- Main Poolが作成できる
- Operations Poolが作成できる
- Earthquake Poolが作成できる
- Poolごとに残高と累計を追跡できる
- paused poolは入出金を拒否できる
- unit testsが通る

### Phase 5. Donation実装

目的:

- General Donation、Designated Donation、Operations Donationをbusiness_logic.md通りに処理する

実装対象:

- donation module
- Donation events
- Pool deposit logic

実装内容:

- donate_general
- donate_designated
- donate_operations
- amount > 0 validation
- paused donation rejection
- General Donationを100% Main Poolへ入金
- Designated Donationを50% Designated Pool、50% Main Poolへ分配
- Operations Donationを100% Operations Poolへ入金
- DonationReceived events
- donor / amount / pool / timestamp をeventに出す

検証項目:

- General Donation 100% Main Pool
- Designated Donation 50/50 split
- Operations Donation 100% Operations Pool
- zero amount reject
- paused donation reject
- unsupported pool reject

完了条件:

- dappから寄付transactionを作れるentryがある
- Pool残高が正しく増える
- eventで寄付履歴をindexできる
- Move testsが通る

### Phase 6. Membership / Verification Fee 実装

目的:

- 支援対象者を事前登録し、Verification FeeをOperations Poolへ入れる

実装対象:

- membership module
- MembershipPass
- Verification Fee処理
- region update
- risk bucket管理
- membership events

実装内容:

- register_member
- Verification Fee受領
- feeをOperations Poolへ入金
- payout address保存
- region_hash保存
- member_since_ms保存
- last_region_change_ms保存
- verification_level保存
- risk_bucket保存
- proof_hash保存
- active flag
- update_member_region
- deactivate membership
- MembershipRegistered event
- MemberRegionUpdated event
- MembershipRiskUpdated event

オンチェーンに出さないもの:

- phone number
- GPS raw data
- device signal
- IP情報
- KYC詳細

検証項目:

- register member
- fee goes to Operations Pool
- zero fee reject
- region update updates cooldown timestamp
- inactive membership cannot claim
- unauthorized membership mutation reject

完了条件:

- MembershipPassが作成できる
- Verification FeeがOperations Poolへ入る
- region change cooldownに使うtimestampが保存される
- risk_bucketをClaimで参照できる
- Move testsが通る

### Phase 7. PayoutPolicy 実装

目的:

- Band、会員期間、risk tier、Pool方針に基づく支払額計算のルールをオンチェーン化する

実装対象:

- payout_policy module
- PayoutPolicy Object
- policy events

実装内容:

- default PayoutPolicy作成
- band別base amount
- partial membership days
- full membership days
- region change cooldown days
- low risk multiplier
- medium risk multiplier
- high risk multiplier
- user max amount
- policy max amount
- designated event spend ratio
- main pool backstop ratio
- future disaster reserve ratio
- policy active flag
- update policy admin entry

MVP値:

- Band 1: 50 USD相当
- Band 2: 150 USD相当
- Band 3: 300 USD相当
- 登録30日未満: 0
- 登録30〜90日: 0.5
- 登録90日以上: 1.0
- 地域変更30日未満: 新地域では0
- Low risk: 1.0
- Medium risk: 0.5
- High risk: 0
- Designated Pool 1イベント最大80%
- Main Pool補填最大20%
- Main Pool totalの最低50%をFuture Disaster Reserveとして残す

検証項目:

- band別base amount取得
- membership multiplier
- risk multiplier
- high risk payout zero
- too-new member payout zero
- policy max amount cap
- user max amount cap
- inactive policy reject

完了条件:

- Claim側から支払額計算に利用できる
- Adminがpolicyを更新できる
- policy update eventが出る
- Move testsが通る

### Phase 8. AffectedCell / Merkle Proof 実装

目的:

- DisasterEventのaffected_cells_rootに含まれるH3セルかどうかをMoveで検証する

実装対象:

- affected_cell module
- AffectedCellLeaf
- Merkle proof verification
- leaf hash calculation

実装内容:

- AffectedCellLeaf struct
- leaf BCS decode
- leaf_hash calculation
- internal_hash calculation
- proof step validation
- root comparison
- event_uid一致検証
- event_revision一致検証
- geo_resolution一致検証
- cell_metric一致検証
- intensity_scale一致検証
- cells_generation_method一致検証
- h3_index一致検証
- cell_band >= min_claim_band検証

検証項目:

- valid proof accepted
- invalid proof rejected
- wrong event_uid rejected
- wrong revision rejected
- wrong h3_index rejected
- low cell_band rejected
- malformed leaf rejected

完了条件:

- Nautilus fixture proofをMoveで検証できる
- DisasterEvent.affected_cells_rootと一致確認できる
- Claim側で利用できる
- Move testsが通る

### Phase 9. EventBudget 実装

目的:

- 1つの災害イベントで使える支払い上限を管理し、Poolを使い切らないようにする

実装対象:

- payout_policy module または pools module
- EventBudget Object

実装内容:

- open_event_budget
- DisasterEvent参照
- matching Designated Pool参照
- Main Pool参照
- designated budget計算
- main backstop budget計算
- total budget計算
- remaining budget管理
- total claimed管理
- active flag
- EventBudgetOpened event

MVP計算式:

- future_reserve_floor = main_pool_total * 50%
- liquid_reserve_target = main_pool_total * 70%
- main_pool_spendable = max(0, main_pool_total - future_reserve_floor)
- main_backstop_budget = min(liquid_reserve_target * 20%, main_pool_spendable)
- designated_budget = designated_pool_balance * 80%
- event_budget = designated_budget + main_backstop_budget

MVP方針:

- 完全な全対象者按分はfutureでもよい
- EventBudget capとremaining budgetは必ず守る
- EventBudget不足時はClaimごとにremaining budget内へcap、または支払い不可にする
- Main Pool Future Disaster Reserveを侵さない
- Designated Pool優先の支払い順序に使う
- 全対象者target_amount合計に基づくdynamic_payout_factorはfuture扱いにする

検証項目:

- EventBudget作成
- designated budget cap
- main backstop cap
- future reserve protection
- exhausted budget reject
- inactive budget reject

完了条件:

- Claim時にEventBudgetを参照できる
- Pool残高を使い切らない
- EventBudgetを超えて支払わない
- Move testsが通る

### Phase 10. Claim / Payout 実装

目的:

- 会員が災害対象地域にいることを証明し、Relief Cashを受け取れるようにする

実装対象:

- claim module
- ClaimReceipt
- claim_relief entry
- payout execution
- duplicate claim prevention
- ClaimPaid event

実装内容:

- DisasterEvent検証
- EventBudget検証
- MembershipPass検証
- AffectedCell proof検証
- PayoutPolicy計算
- target amount計算
- user max cap
- policy max cap
- EventBudget cap
- EventBudget不足時はClaimごとにreject or cap payout
- Designated Pool優先支払い
- Main Pool補填
- Future Disaster Reserve保護
- ClaimReceipt作成
- duplicate claim index登録
- ClaimPaid event emit

Claim時の検証:

- MembershipPass active
- membership owner == claimant
- member_sinceが条件を満たす
- last_region_changeがcooldown条件を満たす
- risk_bucketが支払対象
- Merkle proof valid
- leaf.h3_index == claimed h3_index
- leaf.cell_band >= min_claim_band
- duplicate claimではない
- Pool残高がある
- EventBudget remainingがある

検証項目:

- valid claim succeeds
- non-member rejected
- inactive member rejected
- too-new member payout zero or reject
- region cooldown reject
- high risk reject
- medium risk half payout
- invalid proof reject
- duplicate claim reject
- designated pool pays first
- main pool backstop pays shortage
- EventBudget不足時はreject or cap payout
- paused claim reject

完了条件:

- mainnetで支援金Claimが可能なentryがある
- 二重Claimを拒否できる
- PayoutPolicyに従って金額が決まる
- Poolから正しく支払われる
- Move testsが通る

### Phase 11. Events / Dashboard対応

目的:

- dappと透明性ダッシュボードが必要な情報をindexできるようにする

実装対象:

- events definitions
- emit points

必須events:

- OracleKeyAdded
- OracleKeyDisabled
- DisasterEventCreated
- MembershipRegistered
- MemberRegionUpdated
- GeneralDonationReceived
- DesignatedDonationReceived
- OperationsDonationReceived
- PoolCreated
- PoolPaused
- EventBudgetOpened
- ClaimPaid
- PolicyUpdated
- Paused
- Unpaused

Dashboardで表示する項目:

- Main Pool残高
- Designated Pool残高
- Operations Pool残高
- General Donation累計
- Designated Donation累計
- donation split
- total paid
- event budget
- remaining budget
- future disaster reserve
- claim count
- sponsor contribution

完了条件:

- dappが必要な情報をeventsとObjectから取得できる
- PoolとClaimの透明性を表示できる
- Move testsで主要event emitを確認できる

### Phase 12. Integration with Nautilus Relayer

目的:

- Nautilus Oracleが生成したpayloadをcontractsへ接続する

実装対象:

- relayer target update
- package id / object id config
- dry-run script
- submit script gated by explicit env

やること:

- contractsをlocalnetまたはtestnetへpublish
- OracleRegistryをinitialize
- Oracle public key登録
- Relayer targetをsubmit_finalized_payload_v1へ合わせる
- fixture finalized payloadでdry-run
- invalid payloadでreject確認
- duplicate payloadでreject確認
- transaction digestをD1へ保存する流れを確認

完了条件:

- Nautilus fixture payloadがMove dry-runで成功
- invalid payloadがMove dry-runで拒否
- duplicate event_uidが拒否
- submitはまだ明示envがない限りfail-closed

### Phase 13. dapp smoke integration

目的:

- mainnet完成品に向け、dappから主要操作を実行できるようにする

対象:

- dapp
- packages/config
- contracts object ids

やること:

- package id設定
- registry id設定
- pool object ids設定
- Wallet connect
- Membership registration UI
- General Donation UI
- Designated Donation UI
- DisasterEvent list
- Pool dashboard
- Claim UI
- Claim history
- Donation history

完了条件:

- dappから会員登録できる
- dappから寄付できる
- dappからDisasterEventを表示できる
- dappからClaim transactionを作れる
- dappからPool透明性を確認できる

### Phase 14. Testnet end-to-end

目的:

- mainnet前に全体の流れをtestnetで通す

流れ:

1. contracts publish
2. initialize registry / pools / policy
3. register oracle key
4. register member
5. donate general
6. donate designated
7. Nautilus fixtureまたはlive eventでDisasterEvent作成
8. EventBudget open
9. Claim proof submit
10. payout
11. dashboard表示

完了条件:

- 一連の流れがtestnetで成功する
- Pool残高が正しく変化する
- ClaimReceiptが作られる
- duplicate claimが拒否される
- eventsがdappで読める
- emergency pauseが動作する

### Phase 15. Mainnet deployment

目的:

- ハッカソン提出用にmainnetへ展開する

手順:

1. final Move tests
2. final relayer dry-run
3. deploy checklist確認
4. Sui mainnet publish
5. AdminCap保管
6. OracleRegistry initialize
7. Oracle public key登録
8. Main Pool作成
9. Operations Pool作成
10. Earthquake Designated Pool作成
11. PayoutPolicy作成
12. dapp config更新
13. smoke donation
14. smoke membership registration
15. smoke DisasterEvent submit
16. smoke claim
17. dashboard確認
18. emergency pause確認

完了条件:

- package idが確定
- registry idが確定
- pool idsが確定
- dappがmainnetを参照
- demo flowが動く
- READMEに操作手順がある

## 4. PR分割案

### PR 1. contracts docs

内容:

- contracts/spec.md
- contracts/devflow.md

目的:

- business_logic.mdに従ったcontracts設計を固定する

完了条件:

- docsのみ
- 実装なし
- specとdevflowがmainnet完成品を前提にしている

### PR 2. contracts scaffold

内容:

- Move.toml
- 最小module
- README
- build/test土台

目的:

- contracts開発開始

完了条件:

- build/test可能

### PR 3. admin and pause

内容:

- AdminCap
- pause/unpause
- admin-only tests

目的:

- mainnet運用の安全弁を先に作る

### PR 4. oracle registry and disaster event

内容:

- OracleRegistry
- Oracle key管理
- Payload v1 decode/validation
- signature verification
- submit_finalized_payload_v1
- DisasterEvent作成

目的:

- Nautilus payloadをオンチェーンDisasterEventに変換する

### PR 5. pools

内容:

- Main Pool
- Operations Pool
- Designated Relief Pool
- PoolPolicy
- Pool events

目的:

- business_logic.mdの資金分離を実装する

### PR 6. donation

内容:

- General Donation
- Designated Donation 50/50 split
- Operations Donation
- donation events

目的:

- 寄付金の流れをオンチェーン化する

### PR 7. membership

内容:

- MembershipPass
- Verification Fee
- region registration
- region update
- risk bucket

目的:

- 支援対象者の事前登録基盤を作る

### PR 8. payout policy and event budget

内容:

- PayoutPolicy
- band base amount
- membership multiplier
- risk multiplier
- EventBudget

目的:

- 支払額とPool上限をオンチェーン管理する

### PR 9. affected cell proof

内容:

- AffectedCellLeaf
- Merkle proof verification
- fixture proof tests

目的:

- 災害対象H3セルの証明をMoveで検証する

### PR 10. claim and payout

内容:

- claim_relief
- ClaimReceipt
- duplicate claim prevention
- Designated Pool priority
- Main Pool backstop

目的:

- 支援金支払いを完成させる

### PR 11. relayer integration

内容:

- relayer target update
- dry-run scripts/docs
- package id / registry id config

目的:

- Nautilus Oracleからcontractsへ接続する

### PR 12. dapp integration

内容:

- packages/config
- membership registration UI
- donation UI
- disaster event UI
- claim UI
- dashboard

目的:

- mainnet demoに必要なUIを作る

### PR 13. testnet E2E

内容:

- testnet publish
- testnet object ids
- end-to-end script
- smoke tests

目的:

- mainnet前の総合検証

### PR 14. mainnet release

内容:

- mainnet publish
- final config
- README / demo guide
- deployment notes

目的:

- ハッカソン提出用完成状態

## 5. 開発時の注意

### business_logic.mdを正とする

金銭的な流れは必ずbusiness_logic.mdに従う。

特に以下を守る。

- General Donationは100% Main Pool
- Designated Donationは50% Designated Pool、50% Main Pool
- Verification FeeはOperations Pool
- Designated Pool優先で支払う
- Main Poolは不足時補填
- Main Poolを使い切らない
- Operations PoolをRelief payout原資にしない
- 保険料・掛け金の表現を避ける
- 支払い保証をしない

### Oracleだけで完結させない

Nautilusは災害検証を担当するだけである。最終的な支払いはMoveのPayoutPolicyとPool状態で決める。

### dappから見える状態を意識する

全ての主要操作でeventをemitし、dappとdashboardが表示しやすいようにする。

### mainnet資金を扱う前提で実装する

テストコードであっても、資金流出や権限ミスを起こしにくい設計を優先する。

### 複雑な全対象者按分は後回しでもよい

完全な全対象者比例配分は対象者総数が必要になるためfuture扱いとする。MVPではEventBudget capとClaimごとのremaining budget内cap、または支払い不可の処理を優先する。

### 実DeFi運用はしない

SUI stakingやScallop strategyはMVPではダッシュボード表示と設計に留める。

## 6. 完了ライン

Contracts完成ライン:

- AdminCapがある
- pause/unpauseがある
- OracleRegistryがある
- DisasterEventを作れる
- Main Poolがある
- Operations Poolがある
- Earthquake Designated Poolがある
- General Donationができる
- Designated Donationが50/50 splitされる
- Verification FeeでMembershipPassを作れる
- PayoutPolicyがある
- EventBudgetがある
- AffectedCell proofを検証できる
- ClaimでRelief Cashを支払える
- Designated Pool優先で支払う
- Main Poolで補填できる
- Pool残高とEventBudgetを超えない
- 二重Claimを拒否できる
- emergency pauseが動く
- dappが主要Objectとeventsを読める
- testnet E2Eが通る
- mainnet publish済み
- mainnet demo flowが通る
