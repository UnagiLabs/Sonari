# Sonari Business Logic / 事業・資金設計メモ

## 1. 基本方針

Sonariは、保険商品ではなく、Nautilusで受取対象を検証できる寄付型Programmable Paymentインフラとして設計する。災害支援は最初のユースケースであり、将来的にはStudent Aidや地域支援などのProgram / Campaignにも同じ仕組みを広げられる。

ユーザーの会員登録費や企業・個人からの寄付を受け取るが、災害時の支払いを保証しない。支援は、Program / Campaign条件、災害条件、対象地域、会員登録期間、地域変更クールダウン、不正リスク、プール残高に基づいて実行される。

重要な前提:

- 支払い保証をしない
- 保険料・掛け金という表現を使わない
- 会員登録費は検証、不正対策、運営のための費用とする
- 寄付金の流れ、運用比率、報酬の使途はダッシュボードで透明化する
- NautilusとSui Moveにより、条件付き支払いを検証可能にする
- 支払い判定に使うMembershipPass metadataはNautilus署名済みのものだけを信頼する
- 電話番号、GPS履歴、端末情報、住所、学籍番号などの生データはオンチェーンに出さない

## 2. 資金プール構成

Sonariの資金は、目的別に分離する。

### 2.1 Main Pool / General Relief Pool

用途を限定しない共通支援プール。

役割:

- 未指定寄付の受け皿
- 各災害プール不足時の補填
- 予測できない災害への柔軟な支援
- Sonari全体の緊急流動性

Main Poolは、Sonariの中心となる支援原資であり、災害種別を限定しない。

### 2.2 Designated Relief Pools

災害種別、地域、企業キャンペーンなど、用途を指定した支援プール。

例:

- Earthquake Pool
- Flood Pool
- Typhoon Pool
- Wildfire Pool
- Region Pool
- Sponsor Campaign Pool
- Student Aid Campaign Pool

Designated Poolは、寄付者・企業の意図を反映するためのプールである。災害発生時やCampaign Claim時は、該当するDesignated Poolから先に支払いを行う。

### 2.3 Operations Pool

運営費用のためのプール。

用途:

- Nautilus実行費
- TEE / サーバー / DB / 監視費
- 災害API取得費
- 通知費
- サポート費
- セキュリティ・監査・保守費

Operations Poolの原資:

- 会員登録費 / Verification Fee
- Main Pool Yield Reserveの利回り
- 明示的な運営支援寄付
- 将来的なPlatform Sponsorship

## 3. 寄付の配分ルール

### 3.1 General Donation

用途指定のない寄付。

```text
General Donation
  -> 100% Main Pool
```

Main Pool内では、後述する70% / 15% / 15%ルールを適用する。

### 3.2 Designated Donation

企業や個人が、地震・洪水・地域・学校支援・キャンペーンなどを指定して行う寄付。

MVPでは以下の配分を基本とする。

```text
Designated Donation
  -> 50% Designated Relief Pool
  -> 50% Main Pool
```

理由:

- 指定した災害・地域への支援意図を反映できる
- Main Poolにも流動性が残り、他の災害や不足時補填に使える
- 特定プールだけが偏って、Main Poolが枯れる問題を避けられる

将来的には、企業向けにStrict Designated Donationを用意してもよい。

```text
Strict Designated Donation
  -> 100% Designated Relief Pool / Campaign Pool
```

ただし、MVPでは複雑化を避けるため、Designated Donationは50% / 50%で扱う。

## 4. 災害時の支払い優先順位

この章は、最初のユースケースであるDisaster Relief Programの支払い優先順位を説明する。災害発生時は、Nautilusが災害種別、対象地域、重大度を検証し、Moveコントラクトが対象Poolを選択する。

基本ルール:

```text
1. 該当するDesignated Relief Poolから先に支払う
2. 不足分をMain Poolから補填する
3. それでも不足する場合は、支援額を按分または上限調整する
```

例:

```text
Earthquake occurs
  -> Earthquake Poolから支払い
  -> Earthquake Poolが不足
  -> Main Poolから補填
  -> Main Poolも不足
  -> 支援額を按分 / tier調整
```

原則として、Designated Pool同士の流用はしない。

```text
Flood Poolの資金をEarthquake支援へ使う
  -> 原則不可
```

例外を設ける場合は、寄付時に明示的なPoolPolicyを選べるようにする。

- Strict Designation: 指定用途にのみ使う
- Flexible Relief: 一定期間未使用ならMain Poolへ戻せる
- Emergency Override: 大規模災害時のみ、明示条件で他用途へ移せる

MVPでは、Strict/Flexible/Emergencyの詳細実装は行わず、Main Pool補填までを示す。

## 5. Main Poolの70% / 15% / 15%運用ルール

長期運営にはNautilus、サーバー、通知、監視などの継続費用が必要になる。会員登録費だけでは不足する可能性が高いため、Main Poolの一部を明示的にYield Reserveとして運用する。

MVPでの基本方針:

```text
Main Pool
  -> 70% Liquid Relief Reserve
  -> 15% SUI Native Staking Reserve
  -> 15% Scallop Stablecoin Strategy
```

### 5.1 Liquid Relief Reserve

Main Poolの最低70%を即時支払い用として保持する。

用途:

- 災害時の即時支払い
- Designated Pool不足時の補填
- 予測できない災害への対応

想定通貨:

- USDCなどのステーブルコインを中心にする
- SUIはガス、デモ、Suiネイティブ性の表現に使う

理由:

- 被災者への支援価値を安定させる
- SUI価格変動による支援額のブレを避ける
- 即時支払い能力を確保する

### 5.2 Yield Reserve

Main Poolの最大30%を運用枠とする。

重要なルール:

- 30%は上限であり、固定義務ではない
- 元本はMain Poolの支援原資として扱う
- 利回りはOperations Poolへ送る
- 運用比率、運用先、利回り、使途をダッシュボードで公開する
- 災害発生時は新規運用を停止し、必要に応じて解除して支援原資へ戻す

初期MVPでは、Yield Reserveを2つの戦略に分ける。

```text
Yield Reserve
  -> 15% SUI Native Staking Reserve
  -> 15% Scallop Stablecoin Strategy
  -> generated yield
  -> Operations Pool
```

### 5.3 SUI Native Staking Reserve

Main Poolの最大15%をSuiネイティブバリデータへのステーキングに回す。

目的:

- Suiネイティブの運用手段を使う
- Suiエコシステムへの貢献を示す
- ステーキング報酬をOperations Poolへ送る

注意点:

- SUI価格変動リスクがある
- ステーク解除タイミングにより即時流動性が制限される
- 支援額をUSD建てで安定させたい場合、SUI比率を上げすぎない

### 5.4 Scallop Stablecoin Strategy

Main Poolの最大15%を、ScallopのようなSui上のDeFiにステーブルコインとして預ける戦略を検討する。

目的:

- USDCなどのステーブルコイン建てで運用し、SUI価格変動リスクを抑える
- Suiエコシステム内のDeFiを活用する
- 運用利回りをOperations Poolへ送る

注意点:

- SuiネイティブステーキングよりDeFiプロトコルリスクが高い
- スマートコントラクトリスク、オラクルリスク、流動性リスク、ステーブルコインのデペッグリスクがある
- MVPでは実資金運用ではなく、戦略表示とダッシュボードデモに留める

Scallop等のDeFi戦略を使う場合は、`PoolPolicy` に以下を明示する。

```text
allowed_strategy
target_ratio
max_ratio
asset
risk_level
withdrawal_rule
yield_destination
```

## 6. Operations Poolの考え方

Operations Poolは、Sonariを継続的に動かすための運営原資である。

主な収入源:

```text
1. 会員登録費
2. Main Pool Yield Reserveの利回り
3. 明示的な運営支援寄付
4. 将来的なPlatform Sponsorship
```

主な支出:

```text
1. Nautilus / TEE実行費
2. サーバー / DB / 監視
3. 災害API取得
4. 通知
5. サポート
6. セキュリティ・監査
7. 保守開発
```

Operations Poolは、被災者支援のRelief Poolと分離する。ただし、Main PoolのYield Reserveから得た利回りはOperations Poolへ流れる。

## 7. 会員登録費 / One-time Verification Fee

ユーザーは、平時にcoarse regionと受取ウォレットを登録し、必要に応じて低侵襲なresidence evidenceをNautilus verifierへ提出する。少額の会員登録費は一度だけ支払う。オンチェーン上では、受取者はMembershipPassを持つ。

電話番号、GPS履歴、端末情報、住所、学籍番号などの生データは、Nautilus内またはoffchain evidenceとして扱い、オンチェーンにはbucket、hash、confidence、risk tierなどの最小情報だけを出す。

会員登録費は年会費ではなく、継続的な掛け金でもない。一度きりの `Verification Fee` として扱う。

会員登録費の位置づけ:

- 保険料ではない
- 支援金の購入ではない
- 受け取りAddress、地域、本人性、不正リスクを事前検証するための費用
- Nautilus検証、通知、最低限の登録処理を支える補助費用
- 複数アカウント大量作成への経済的ハードル

MembershipPassを持つことは支援対象判定の前提になるが、支払いを保証しない。

### 7.1 なぜ有料登録が必要か

有料の事前登録が必要な理由は、主に3つある。

#### 1. 受け取りAddressを事前に確定するため

災害発生後に初めてAddress登録を許すと、駆け込み登録、なりすまし、大量アカウント作成が起きやすい。

平時にWallet Addressを登録しておくことで、災害時に以下の流れを自動化できる。

```text
EligibilityProof
  -> MembershipPass metadata
  -> verified payout address
  -> Relief Cash transfer
  -> ReliefReceipt
```

これにより、災害時にユーザーが複雑な申請を行わなくても、事前登録されたAddressへ支援金を届けられる。

#### 2. 対象地域の人かを判断するため

coarse region、check-in consistency、account age、Pass age、地域変更履歴などのsignalがなければ、その人が対象地域に関係するかを十分に判断できない。

災害後に登録された情報だけでは信頼性が低いため、平時から地域登録と滞在証明を蓄積する。

Nautilusはこれらの詳細情報を秘匿したまま、以下だけを証明する。

```text
eligible_region
verified_residence_cell
member_since_bucket
last_region_change_bucket
risk_tier
payout_address
max_amount
```

#### 3. 重複受け取り・複数アカウントを防ぐため

無料登録だけにすると、大量アカウント作成のコストが低くなり、Sybil攻撃や重複受け取りが起きやすくなる。

少額の一度きりVerification Feeは、複数アカウント作成への経済的ハードルになる。

さらに、以下のようなsignalをNautilus内で正規化し、hashまたはbucketとしてリスク評価する。

- duplicate contact hash signal
- passkey / browser consistency signal
- coarse check-in distribution hash
- IP / VPN / ASN risk bucket
- 会員登録費の支払い手段 hash
- 地域変更履歴

オンチェーンには個別情報を出さず、`risk_tier` や `proof_hash` のみを出す。Student AidのようなProgramでも、学籍番号や学校メールなどの生データは出さず、Nautilus署名済みのStudent metadataだけを使う。

### 7.2 登録時に扱う情報

登録時には、以下を扱う。

```text
User Registration
  -> wallet address
  -> coarse region declaration
  -> residence evidence snapshot hash
  -> risk signal hashes / buckets
  -> one-time verification fee
  -> MembershipPass
  -> Nautilus signed metadata update
```

オンチェーンには、最小限の情報だけを残す。

```text
MembershipPass {
  pass_lineage_id
  owner
  payout_address
  verified_residence_cell
  member_since
  last_region_change
  verification_level
  risk_bucket
}
```

電話番号、GPS履歴、端末情報、住所、学籍番号などの生データはオンチェーンに出さない。支払い判定に使うPass metadataは、Nautilus署名済みの更新結果だけを信頼する。

支援対象になるには、以下を満たす必要がある。

- 災害条件を満たす
- 対象地域に登録されている
- 登録から一定期間が経過している
- 地域変更から一定期間が経過している
- 重複申請リスクが低い
- Poolに十分な残高がある

## 8. 企業スポンサー向け価値

企業スポンサーは、General DonationまたはDesignated Donationを選べる。Designated Donationは、災害支援だけでなくStudent Aidや地域支援などのCampaignにも拡張できる。

### 8.1 General Donation

用途を限定せず、Main Poolへ寄付する。

企業側のメリット:

- 災害種別を問わず、最も必要な支援へ使われる
- Sonari全体の緊急流動性に貢献できる
- Main Pool貢献としてランキング・Partner Badgeに反映できる

### 8.2 Designated Donation

地震、洪水、地域、学校支援、企業キャンペーンなどを指定して寄付する。

MVP配分:

```text
50% Designated Relief Pool
50% Main Pool
```

企業側のメリット:

- 特定災害・地域への支援意思を示せる
- 同時にMain Poolにも貢献し、全体の災害対応力を支えられる
- SponsorProfileで内訳を表示できる

表示例:

```text
Sponsor A
Total donated: $10,000
Earthquake Pool: $5,000
Main Pool contribution: $5,000
People reached: 320
Regions supported: 4
```

## 9. 透明性ダッシュボード

Sonariでは、資金の流れをオンチェーンデータとダッシュボードで見せる。

表示すべき項目:

- Main Pool残高
- Designated Pool別残高
- Liquid Relief Reserve比率
- Yield Reserve比率
- 運用先
- 発生した利回り
- Operations Poolへ送られた金額
- Nautilus / インフラ / 通知などの支出カテゴリ
- 災害別支払い額
- Program / Campaign別支払い額
- 地域別支払い額
- スポンサー別寄付額
- Sponsor Impact SBT / Partner Badge

これにより、寄付者・企業・ユーザーが「何に使われたか」を確認できる。

## 10. リスクと制約

### 10.1 SUI価格変動リスク

SuiネイティブステーキングはSui文脈と相性が良いが、SUI価格変動リスクがある。

対策:

- 支援金の中心はUSDCなどのステーブルコインにする
- SUIステーキングはMain Poolの最大15%に限定する
- Yield Reserve全体でも最大30%に抑える
- SUIとステーブルコイン戦略を分けることで価格変動リスクを下げる

### 10.2 流動性リスク

ステーキング中の資金は即時支払いに使えない可能性がある。

対策:

- 最低70%をLiquid Relief Reserveとして保持する
- 災害発生時は新規運用を停止する
- PoolPolicyで最低流動性比率を定義する

### 10.3 DeFi運用リスク

ステーブルコインを外部DeFiで運用すると、スマートコントラクト、流動性、オラクル、デペッグなどのリスクが増える。

MVP方針:

- 外部DeFiの実資金運用は行わない
- Scallop Stablecoin Strategyは戦略表示とダッシュボードデモに留める
- SuiネイティブステーキングとScallop等のDeFi戦略を分離してリスク表示する

### 10.4 保険・共済に見えるリスク

ユーザー会費を集め、災害時の支払いを期待させると、保険・共済に近づく。

対策:

- 会員登録費は保険料ではないと明記する
- 支払い保証をしない
- Relief Poolは寄付ベースであると説明する
- 支援はPool残高と条件に基づく

## 11. 支払額決定ロジック

SonariのRelief Cashは、固定額を手動で決めるのではなく、`PayoutPolicy` に基づいて計算する。

基本方針:

```text
支払額 = 災害の深刻度 × 会員状態 × 不正リスク係数
ただし、Pool残高とイベント予算上限を超えない
```

Nautilusは災害Band、対象地域、Eligibilityに必要な事実を証明する。最終的な支払額は、Moveコントラクトがオンチェーンの `PayoutPolicy` とPool残高に基づいて決める。

### 11.1 MVPのBase Amount

MVPでは、災害直後の一時支援として、以下のBase Amountを使う。

```text
Band 1 / 軽度対象: $50
Band 2 / 中度対象: $150
Band 3 / 重度対象: $300
```

位置づけ:

- 生活再建の全額補償ではない
- 災害直後の食料、水、通信、交通、避難などに使える即時Relief Cash
- 高額補償ではなく、迅速性と透明性を重視する

Nautilus Earthquake Oracleでは、MVPの地震Bandを以下のように扱う。

```text
Band 1: 7.0 <= USGS MMI < 7.5
Band 2: 7.5 <= USGS MMI < 8.0
Band 3: USGS MMI >= 8.0
```

### 11.2 会員状態による係数

災害直前の駆け込み登録や住所変更による不正受給を防ぐため、会員期間と地域変更からの経過期間を支払額に反映する。

MVP係数:

```text
登録30日未満
  -> 0

登録30〜90日
  -> 0.5

登録90日以上
  -> 1.0

地域変更から30日未満
  -> 新地域では0
```

例:

```text
Band 2 base amount = $150
登録45日 = 0.5
risk multiplier = 1.0

payout = 150 * 0.5 * 1.0 = $75
```

### 11.3 不正リスク係数

Nautilus Membership VerifierまたはEligibility Claim層で、duplicate contact hash、passkey / browser consistency、coarse check-in distribution hash、IP / VPN / ASN risk bucket、会員登録費の支払い手段 hashなどを評価し、支援ティアまたはrisk multiplierを出す。

MVP係数:

```text
Low risk
  -> 1.0

Medium risk
  -> 0.5

High risk
  -> 0
```

オンチェーンには、個別のリスク要素を出さない。Moveには `risk_tier` または `risk_multiplier_bucket` と `proof_hash` だけを渡す。

### 11.4 支払額計算式

```text
target_amount =
  base_amount_by_band
  * membership_multiplier
  * risk_multiplier
```

ただし、以下の上限を適用する。

```text
target_amount <= user_max_amount
target_amount <= policy_max_amount
```

`user_max_amount` はEligibility ProofまたはNautilus署名済みPass metadataに含まれる支払い上限、`policy_max_amount` はPool、Program、災害種別ごとの上限である。

### 11.5 Future Disaster ReserveとEvent Budget Cap

災害時にPool全額を使い切ると、次の災害に対応できなくなる。そのため、Sonariは1回の災害イベントで使える予算を制限し、Main PoolにFuture Disaster Reserveを残す。汎用Programでは、同じ考え方をCampaignBudgetとして扱える。

重要な概念:

- `Future Disaster Reserve`: 次の災害に備えて残す最低残高
- `Event Budget Cap`: 1つの災害イベントで使える上限
- `Dynamic Payout Factor`: Pool状況に応じて支払額を調整する係数

MVPルール:

```text
Designated Pool
  -> 1イベントで最大80%まで使用可能

Main Pool Liquid Relief Reserve
  -> 1イベントで最大20%まで補填可能
  -> 最低50%はFuture Disaster Reserveとして残す
```

例:

```text
Earthquake Pool: $20,000
Main Liquid Pool: $100,000

Earthquake Event Budget:
  Earthquake Poolから最大80% = $16,000
  Main Poolから最大20% = $20,000

event_budget = $36,000
```

これにより、1回の災害で全Poolを使い切らず、次の災害に備える流動性を維持する。

### 11.6 Pool不足時の按分

災害イベントごとに、利用可能なEvent Budgetを計算する。

```text
event_budget =
  min(
    matching_designated_pool_available * designated_event_spend_ratio,
    designated_pool_event_cap
  )
  +
  min(
    main_pool_liquid_available * main_pool_event_spend_ratio,
    main_pool_event_cap
  )
```

全対象者の `target_amount` 合計が `event_budget` 以下なら満額支払う。

```text
if total_target <= event_budget:
  payout = target_amount
```

不足する場合は、比例配分する。

```text
if total_target > event_budget:
  dynamic_payout_factor = event_budget / total_target
  payout = target_amount * dynamic_payout_factor
```

これにより、早い者勝ちではなく、対象者全体に公平に分配できる。

### 11.7 Pool選択と支払い順序

支払いは、既存のPool優先順位に従う。

```text
1. matching Designated Relief Pool
2. Main Pool backstop
3. proportional payout if insufficient
```

例:

```text
Earthquake Event Budget
  Earthquake Pool available: $20,000
  Main Pool backstop: $10,000
  total event_budget: $30,000

total target_amount: $40,000

各ユーザーのpayout:
  target_amount * 30,000 / 40,000
```

### 11.8 PayoutPolicy Object案

Move側では、支払額のルールを `PayoutPolicy` Objectとして管理する。

```text
PayoutPolicy {
  program_type
  disaster_type
  severity_band
  base_amount
  min_membership_age_days
  partial_membership_age_days
  partial_membership_multiplier
  max_amount
  event_budget_cap
  designated_event_spend_ratio
  main_pool_event_spend_ratio
  future_disaster_reserve_ratio
  main_pool_backstop_ratio
  risk_tier_multipliers
}
```

MVPでは複雑な管理UIは作らず、デモ用に固定の `PayoutPolicy` を表示する。

### 11.9 ハッカソンMVPの支払いルールまとめ

```text
Band 1: $50
Band 2: $150
Band 3: $300

登録30日未満: 対象外
登録30〜90日: 50%
登録90日以上: 100%

Low risk: 100%
Medium risk: 50%
High risk: 対象外

Designated Pool優先
Main Poolで補填
1イベントでPoolを使い切らない
Future Disaster Reserveを残す
不足時は按分
```

## 12. ハッカソンMVPで見せる範囲

MVPでは、複雑な実運用よりも、資金設計の透明性とProgrammable Paymentの流れを見せる。

ただし、審査員に短時間で伝えるMVP説明では、会員登録費、Operations Pool、SUI staking、Scallop運用を深掘りしない。主役はあくまで、Nautilusによる災害検証と、Sui Move上のPayoutPolicyに基づくRelief Cash自動支払いである。

### 12.0 MVP説明での扱い

MVPピッチでは、各要素を以下の粒度で扱う。

| 要素 | MVPでの扱い |
| --- | --- |
| 事前登録 | 最小限だけ触れる |
| 登録費 / 会員費 | 基本的に触れない |
| Scallop運用 | 将来拡張として軽く触れる |
| SUI staking | ほぼ触れない |
| Operations Pool | 必要なら1文だけ |
| 主役 | Nautilus検証と自動支払い |

ユーザー登録は、支払い対象者を判定するための前提として扱う。

良い説明:

```text
Users pre-register their region and payout wallet before a disaster.
When a disaster is verified, Sonari checks their Membership Pass metadata and sends relief cash automatically.
```

日本語:

```text
ユーザーは平時に地域と受取ウォレットを事前登録します。
災害発生後、Sonariは対象地域、Membership Passの登録状態、不正リスクを検証し、
条件を満たすユーザーへ自動でRelief Cashを送ります。
```

MVP説明で避ける表現:

- 会員登録費を払う
- 会員になる
- 支援を受けられる
- 掛け金ではない
- 保険ではない

登録費や保険との違いを説明し始めると、逆に保険に近い印象を与える。MVPでは「事前登録された対象者に、自動で支援金を送る」という説明に留める。

### 12.0.1 Sui向けの位置づけ

Sonariは、単なる災害支援アプリとして見せるよりも、Sui上の `disaster-triggered liquidity activation protocol` として見せる。

整理:

```text
災害支援
  -> ユースケース

本質
  -> 条件付きで資金Poolを動かすProgrammable Payment / Treasury Infrastructure
```

Sui関係者・スポンサー向けの一言:

```text
Sonari turns corporate disaster relief budgets into transparent,
programmable liquidity on Sui, verified by Nautilus and activated
only when real-world disasters happen.
```

日本語:

```text
Sonariは、企業の災害支援予算をSui上の透明でプログラム可能な流動性に変え、
Nautilusで現実世界の災害が検証されたときだけ支払いを実行します。
```

重要なのは、寄付金を「外部からSuiへ入ってくるRelief Pool TVL」として語ることである。

```text
Corporate sponsors / donors
  -> deposit USDC or SUI into Sui-based Relief Pools
  -> funds remain visible on-chain
  -> disaster-specific pools create sticky TVL
  -> payouts generate real payment transactions and receipts
  -> future idle liquidity can compose with Sui DeFi such as Scallop
```

SonariがSuiにもたらすもの:

- 外部の企業CSR、防災、寄付予算をSui上のPool TVLに変える
- Relief Pool残高をオンチェーンで透明化する
- 災害発生時に多数の小口Payment TxとReceiptを発生させる
- Sponsor Impactにより、企業が継続寄付する理由を作る
- 将来的にScallop、zkLogin、WalrusなどのSuiインフラと合成できる

運用については、将来拡張として以下の程度に留める。

```text
Future versions can allocate a capped portion of idle pool liquidity
to transparent treasury strategies such as Scallop, but the MVP focuses
only on verified disaster-triggered payouts.
```

日本語:

```text
将来的には、Poolの一部をScallopのような透明なTreasury Strategyに
割り当てることもできます。ただし、MVPでは災害検証と自動支払いに集中します。
```

ScallopはMVPの主役ではなく、将来の持続運営レイヤーとして説明する。

```text
Sonari can become a new source of stable, purpose-driven TVL for Sui DeFi.
Relief pools stay mostly liquid for emergency payouts, but a capped portion
of idle liquidity can later be routed into Scallop to fund operations transparently.
```

日本語:

```text
Sonariは、Sui DeFiに対して新しい種類のTVLを持ち込めます。
Relief Poolの大部分は即時支払い用に保持しつつ、
将来的には未使用流動性の一部をScallopに接続し、
運営費を透明に賄うことができます。
```

### 12.1 MVPで完璧に完成させるEnd-to-End Flow

ハッカソンMVPでは、広い機能を浅く見せるよりも、以下の1本の流れを完成度高く見せることを最優先にする。

```text
Sponsor donates to Earthquake Pool
  -> 50% goes to Earthquake Pool
  -> 50% goes to Main Pool
  -> earthquake event is verified by Nautilus
  -> eligible user's Eligibility Proof and MembershipPass metadata are accepted
  -> PayoutPolicy calculates payout amount
  -> Earthquake Pool pays first
  -> Main Pool covers shortage if needed
  -> Relief Receipt is issued
  -> Sponsor Impact is updated
```

日本語でのデモ説明:

```text
スポンサーがEarthquake Poolへ寄付する
  -> 50%がEarthquake Pool、50%がMain Poolへ分配される
  -> 地震イベントがNautilusで検証される
  -> 対象ユーザーのEligibility ProofとMembershipPass metadataが通る
  -> PayoutPolicyで支払額が決まる
  -> Earthquake Poolから先に支払い、不足分をMain Poolが補填する
  -> Relief ReceiptとSponsor Impactが更新される
```

この流れは、Sonariの審査上の強みを最も短く伝える。

- 寄付者の意図がDesignated Poolに反映される
- Main Poolにより、単一災害Pool不足時も支援を継続できる
- Nautilusにより、災害情報とEligibilityを検証できる
- Sui Moveにより、Pool選択、支払額計算、Receipt発行をオンチェーンで実行できる
- Sponsor Impactにより、企業側の寄付メリットを可視化できる

### 12.2 MVP実装優先順位

優先順位は以下とする。

#### Priority 0 / 必ず完成させる

審査デモで必ず通すコアフロー。

1. スポンサー寄付の受付
2. Designated Donationの50% / 50%分配
3. Earthquake PoolとMain Poolの残高更新
4. Nautilusによる地震イベント検証
5. Eligibility Proof検証
6. PayoutPolicyによる支払額計算
7. Earthquake Pool優先の支払い
8. 不足時のMain Pool補填
9. Relief Receipt発行
10. Sponsor Impact更新
11. ダッシュボードで一連の状態遷移を表示

完成条件:

- 1回のデモで、寄付から支払い、Receipt、Sponsor Impact更新まで途切れず見せられる
- Pool残高の変化が画面上で追える
- Earthquake Pool優先、Main Pool補填の順序が明確に見える
- PayoutPolicyの入力と出力が説明できる
- Nautilusが何を検証し、Moveが何を実行するかが分離して伝わる

#### Priority 1 / できれば入れる

コアフローの説得力を高める要素。

- Event Budget Cap
- Future Disaster Reserve
- Pool不足時の比例配分
- 事前登録期間による支払額調整
- risk tierによる支払額調整
- Sponsor Ranking
- Partner Badge
- Designated Pool別の残高表示

#### Priority 2 / デモでは表示中心でよい

実運用では重要だが、ハッカソンMVPでは実資金連携まで行わなくてよい要素。

- SUI Native Staking実運用
- Scallop Stablecoin Strategy実入金
- 複雑なPoolPolicy UI
- Flood Poolや他災害Poolの完全実装
- 本番レベルの本人確認
- 本番レベルの通知・サポート運用

### 12.3 MVPで扱う主要Object

コアフローでは、以下のObjectまたは状態を使う。

```text
SponsorProfile
DonationReceipt
MainPool
EarthquakePool
DisasterEvent
EligibilityProof
MembershipPass
PayoutPolicy
ReliefReceipt
SponsorImpact
```

Object間の関係:

```text
SponsorProfile
  -> DonationReceipt
  -> EarthquakePool / MainPool balance update

DisasterEvent
  -> verified by Nautilus
  -> selects EarthquakePool

EligibilityProof
  -> verifies user eligibility with MembershipPass metadata
  -> provides risk tier and max amount

PayoutPolicy
  -> calculates payout
  -> applies event budget and pool priority

ReliefReceipt
  -> records payout result
  -> updates SponsorImpact
```

デモ本体で作るもの:

- Main Pool
- Earthquake Pool
- Designated Donationの50% / 50%配分デモ
- Liquid Relief Reserve
- Future Disaster Reserve
- Nautilusによる災害検証
- Eligibility Proof / MembershipPass metadata検証
- PayoutPolicy表示
- Band別支払額の表示
- 事前登録期間・リスク係数による支払額調整
- Event Budget Cap表示
- Future Disaster Reserve表示
- Pool不足時の按分デモ
- 対象Pool選択
- Relief Cash自動支払い
- Relief Receipt発行
- Sponsor Impact SBT更新
- 透明性ダッシュボード

将来拡張または補足として薄く触れるもの:

- Flood Pool
- Student Aid Campaign
- Main Poolの70% / 15% / 15%配分表示
- SUI Native Staking Reserve
- Scallop Stablecoin Strategy
- Operations Pool
- Sponsor Ranking
- Partner Badge

MVPではやらないもの:

- 実際の外部DeFi運用
- 実際のScallop入金
- 本格的な保険・共済設計
- 戦争・紛争支援
- 複雑なPoolPolicy UI
- 実災害での本番支払い

## 13. 現時点の推奨ルールまとめ

```text
General Donation
  -> 100% Main Pool

Designated Donation
  -> 50% Designated Relief Pool
  -> 50% Main Pool

Main Pool
  -> at least 70% Liquid Relief Reserve
  -> up to 15% SUI Native Staking Reserve
  -> up to 15% Scallop Stablecoin Strategy

Yield Reserve
  -> SUI native staking + Scallop stablecoin strategy
  -> rewards to Operations Pool
  -> principal remains relief reserve

Disaster Payout
  -> matching Designated Pool first
  -> Main Pool backstop second
  -> proportional payout if insufficient

MembershipPass
  -> required for recipients
  -> Nautilus signed metadata only for payout decisions
  -> raw personal data stays off-chain

Operations Pool
  -> membership fees
  -> staking rewards
  -> explicit operations support

PayoutPolicy
  -> Band 1: $50
  -> Band 2: $150
  -> Band 3: $300
  -> membership multiplier
  -> risk multiplier
  -> event budget cap
  -> future disaster reserve
  -> proportional payout if insufficient
```

## 14. Pitch用表現

### 14.1 MVP Pitch Structure

MVPピッチは以下の順番にする。

1. Problem

災害時の支援金は遅く、不透明で、申請が複雑。

2. Solution

Sonariは、企業スポンサーや寄付者の資金をSui上の透明なRelief Poolとして取り込み、Nautilusで検証された現実世界の災害条件に応じて、Sui Move上のPayoutPolicyで即時支払いを実行する。

3. Demo

地震イベント発生、Nautilus検証、対象者判定、Relief Cash送金、Receipt発行、Dashboard更新までを一気通貫で見せる。

4. Why Sui

Move ObjectでPool、Policy、Receiptを透明に管理できる。Suiの高速決済により、災害直後の小口支払いに向いている。

5. Future

スポンサーPool、Scallop Treasury Strategy、Sponsor Impact SBT、地域拡張。

### 14.2 審査員向けの3つのメッセージ

1. Real-world payment rail

Sonari proves Sui can power real-world emergency payments, not just crypto-native trading.

2. New TVL source

Corporate and donor relief funds become transparent on-chain pools on Sui.

3. Ecosystem composability

Once relief pools exist, they can compose with Scallop, zkLogin, Walrus, and other Sui infrastructure.

日本語:

1. Real-world payment rail

Sonariは、Suiがcrypto-nativeな取引だけでなく、現実世界の緊急支払いにも使えることを示す。

2. New TVL source

企業や寄付者の災害支援資金が、Sui上の透明なPool TVLになる。

3. Ecosystem composability

Relief Poolが存在すれば、Scallop、zkLogin、WalrusなどのSuiインフラと将来的に合成できる。

### 14.3 MVP Pitch Copy

日本語:

> Sonariは、企業の災害支援予算をSui上の透明でプログラム可能な流動性に変え、Nautilusで現実世界の災害が検証されたときだけ支払いを実行するProgrammable Disaster Relief Networkです。

> 災害支援は単なるチャリティではなく、企業にとって継続的なCSR、防災、地域支援予算です。Sonariは、その予算をSui上のRelief Pool TVLに変換し、災害時には小口Payment TxとオンチェーンReceiptを発生させます。

> ユーザーは平時に地域と受取ウォレットを事前登録します。災害発生後、Sonariは対象地域、登録状態、不正リスクを検証し、条件を満たすユーザーへ自動で支援金を送ります。

> MVPでは、スポンサーがEarthquake Poolへ寄付し、50%がEarthquake Pool、50%がMain Poolへ分配されます。地震イベントが検証されると、PayoutPolicyが支払額を決め、Earthquake Poolから先に支払い、不足分をMain Poolが補填します。最後にRelief ReceiptとSponsor Impactが更新されます。

> 将来的には、Relief Poolの一部をScallopのような透明なTreasury Strategyに接続し、未使用流動性を運営費の原資にできます。ただし、MVPでは災害検証と自動支払いに集中します。

English:

> Sonari turns corporate disaster relief budgets into transparent, programmable liquidity on Sui, verified by Nautilus and activated only when real-world disasters happen.

> Disaster relief is not just a charity use case. It is a recurring corporate budget category for CSR, preparedness, and local support. Sonari turns that budget into Relief Pool TVL on Sui, then generates real payment transactions and on-chain receipts when disasters occur.

> Users pre-register their region and payout wallet before a disaster. When a disaster is verified, Sonari checks the affected region, registration state, and fraud risk, then sends relief cash automatically to eligible users.

> In the MVP, a sponsor donates to the Earthquake Pool, and the donation is split between the Earthquake Pool and the Main Pool. Once the earthquake event is verified, PayoutPolicy calculates the payout amount, the Earthquake Pool pays first, and the Main Pool covers any shortage. Relief Receipt and Sponsor Impact are updated at the end of the flow.

> Future versions can route a capped portion of idle relief liquidity into transparent treasury strategies such as Scallop to fund operations, but the MVP focuses only on verified disaster-triggered payouts.
