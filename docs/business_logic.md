# Sonari Business Logic / 事業・資金設計メモ

## 1. 基本方針

Sonariは、保険商品ではなく、災害支援のための寄付型Programmable Paymentインフラとして設計する。

ユーザーの会員登録費や企業・個人からの寄付を受け取るが、災害時の支払いを保証しない。支援は、災害条件、対象地域、会員登録期間、地域変更クールダウン、不正リスク、プール残高に基づいて実行される。

重要な前提:

- 支払い保証をしない
- 保険料・掛け金という表現を使わない
- 会員登録費は検証、不正対策、運営のための費用とする
- 寄付金の流れ、運用比率、報酬の使途はダッシュボードで透明化する
- NautilusとSui Moveにより、条件付き支払いを検証可能にする

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

Designated Poolは、寄付者・企業の意図を反映するためのプールである。災害発生時は、該当するDesignated Poolから先に支払いを行う。

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

- 会員登録費
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

Main Pool内では、後述する70% / 30%ルールを適用する。

### 3.2 Designated Donation

企業や個人が、地震・洪水・地域・キャンペーンなどを指定して行う寄付。

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
  -> 100% Designated Relief Pool
```

ただし、MVPでは複雑化を避けるため、Designated Donationは50% / 50%で扱う。

## 4. 災害時の支払い優先順位

災害発生時は、Nautilusが災害種別、対象地域、重大度を検証し、Moveコントラクトが対象Poolを選択する。

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

## 5. Main Poolの70% / 30%運用ルール

長期運営にはNautilus、サーバー、通知、監視などの継続費用が必要になる。会員登録費だけでは不足する可能性が高いため、Main Poolの一部を明示的にYield Reserveとして運用する。

MVPでの基本方針:

```text
Main Pool
  -> 70% Liquid Relief Reserve
  -> 30% Yield Reserve
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

初期MVPでは、Suiネイティブバリデータへのステーキングを第一候補とする。

```text
Yield Reserve
  -> Sui native staking
  -> staking rewards
  -> Operations Pool
```

将来的には、明示的なリスク表示のもとで、ステーブルコインの保守的運用を検討できる。ただし、外部DeFi運用はSuiネイティブステーキングよりリスクが高いため、MVPでは実運用しない。

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

ユーザーは、平時に地域、電話番号、GPSなどによる位置情報を登録し、少額の会員登録費を一度だけ支払って検証済み会員になる。

会員登録費は年会費ではなく、継続的な掛け金でもない。一度きりの `Verification Fee` として扱う。

会員登録費の位置づけ:

- 保険料ではない
- 支援金の購入ではない
- 受け取りAddress、地域、本人性、不正リスクを事前検証するための費用
- Nautilus検証、通知、最低限の登録処理を支える補助費用
- 複数アカウント大量作成への経済的ハードル

会員であることは支援対象判定の前提になるが、支払いを保証しない。

### 7.1 なぜ有料登録が必要か

有料の事前登録が必要な理由は、主に3つある。

#### 1. 受け取りAddressを事前に確定するため

災害発生後に初めてAddress登録を許すと、駆け込み登録、なりすまし、大量アカウント作成が起きやすい。

平時にWallet Addressを登録しておくことで、災害時に以下の流れを自動化できる。

```text
EligibilityProof
  -> verified payout address
  -> Relief Cash transfer
  -> ReliefReceipt
```

これにより、災害時にユーザーが複雑な申請を行わなくても、事前登録されたAddressへ支援金を届けられる。

#### 2. 対象地域の人かを判断するため

地域、電話番号、GPS、チェックイン、滞在履歴などの情報がなければ、その人が本当に対象地域の住民または滞在者か判断できない。

災害後に登録された情報だけでは信頼性が低いため、平時から地域登録と滞在証明を蓄積する。

Nautilusはこれらの詳細情報を秘匿したまま、以下だけを証明する。

```text
eligible_region
member_since_bucket
last_region_change_bucket
risk_tier
payout_address
max_amount
```

#### 3. 重複受け取り・複数アカウントを防ぐため

無料登録だけにすると、大量アカウント作成のコストが低くなり、Sybil攻撃や重複受け取りが起きやすくなる。

少額の一度きりVerification Feeは、複数アカウント作成への経済的ハードルになる。

さらに、以下の情報を組み合わせてNautilus内でリスク評価する。

- 電話番号
- 端末情報
- チェックイン履歴
- IP帯
- 会員登録費の支払い手段
- 地域変更履歴

オンチェーンには個別情報を出さず、`risk_tier` や `proof_hash` のみを出す。

### 7.2 登録時に扱う情報

登録時には、以下を扱う。

```text
User Registration
  -> wallet address
  -> phone verification
  -> region_id
  -> GPS / check-in proof
  -> device signal
  -> one-time verification fee
  -> MembershipPass
```

オンチェーンには、最小限の情報だけを残す。

```text
MembershipPass {
  wallet_address
  region_id or region_id_hash
  member_since
  last_region_change
  verification_level
  risk_bucket
}
```

電話番号、GPS履歴、端末情報などの生データはオンチェーンに出さない。

支援対象になるには、以下を満たす必要がある。

- 災害条件を満たす
- 対象地域に登録されている
- 登録から一定期間が経過している
- 地域変更から一定期間が経過している
- 重複申請リスクが低い
- Poolに十分な残高がある

## 8. 企業スポンサー向け価値

企業スポンサーは、General DonationまたはDesignated Donationを選べる。

### 8.1 General Donation

用途を限定せず、Main Poolへ寄付する。

企業側のメリット:

- 災害種別を問わず、最も必要な支援へ使われる
- Sonari全体の緊急流動性に貢献できる
- Main Pool貢献としてランキング・Partner Badgeに反映できる

### 8.2 Designated Donation

地震、洪水、地域、企業キャンペーンなどを指定して寄付する。

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
- 地域別支払い額
- スポンサー別寄付額
- Sponsor Impact SBT / Partner Badge

これにより、寄付者・企業・ユーザーが「何に使われたか」を確認できる。

## 10. リスクと制約

### 10.1 SUI価格変動リスク

SuiネイティブステーキングはSui文脈と相性が良いが、SUI価格変動リスクがある。

対策:

- 支援金の中心はUSDCなどのステーブルコインにする
- SUIステーキングはMain Poolの最大30%に限定する
- 30%は上限であり、状況に応じて下げられる

### 10.2 流動性リスク

ステーキング中の資金は即時支払いに使えない可能性がある。

対策:

- 最低70%をLiquid Relief Reserveとして保持する
- 災害発生時は新規運用を停止する
- PoolPolicyで最低流動性比率を定義する

### 10.3 DeFi運用リスク

ステーブルコインを外部DeFiで運用すると、スマートコントラクト、流動性、オラクル、デペッグなどのリスクが増える。

MVP方針:

- 外部DeFi運用は行わない
- Suiネイティブステーキングをデモ・将来運用の第一候補とする
- 外部DeFi運用は将来オプションとして扱う

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
Band 1: USGS MMI VII以上 / JMA震度6弱
Band 2: USGS MMI VIII以上 / JMA震度6強
Band 3: USGS MMI IX以上 / JMA震度7
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

NautilusまたはEligibility Claim層で、電話番号、端末、チェックイン履歴、IP帯、会員登録費の支払い手段などを評価し、支援ティアまたはrisk multiplierを出す。

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

`user_max_amount` はEligibility Proofに含まれる支払い上限、`policy_max_amount` はPoolまたは災害種別ごとの上限である。

### 11.5 Pool不足時の按分

災害イベントごとに、利用可能なEvent Budgetを計算する。

```text
event_budget =
  matching_designated_pool_available
  + main_pool_backstop_available
```

全対象者の `target_amount` 合計が `event_budget` 以下なら満額支払う。

```text
if total_target <= event_budget:
  payout = target_amount
```

不足する場合は、比例配分する。

```text
if total_target > event_budget:
  payout = target_amount * event_budget / total_target
```

これにより、早い者勝ちではなく、対象者全体に公平に分配できる。

### 11.6 Pool選択と支払い順序

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

### 11.7 PayoutPolicy Object案

Move側では、支払額のルールを `PayoutPolicy` Objectとして管理する。

```text
PayoutPolicy {
  disaster_type
  severity_band
  base_amount
  min_membership_age_days
  partial_membership_age_days
  partial_membership_multiplier
  max_amount
  event_budget_cap
  main_pool_backstop_ratio
  risk_tier_multipliers
}
```

MVPでは複雑な管理UIは作らず、デモ用に固定の `PayoutPolicy` を表示する。

### 11.8 ハッカソンMVPの支払いルールまとめ

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
不足時は按分
```

## 12. ハッカソンMVPで見せる範囲

MVPでは、複雑な実運用よりも、資金設計の透明性とProgrammable Paymentの流れを見せる。

作るもの:

- Main Pool
- Earthquake Pool
- Flood Pool
- Designated Donationの50% / 50%配分デモ
- Main Poolの70% / 30%配分表示
- Liquid Relief Reserve
- Yield Reserve
- Operations Pool
- Nautilusによる災害検証
- Eligibility Proof検証
- PayoutPolicy表示
- Band別支払額の表示
- 会員期間・リスク係数による支払額調整
- Pool不足時の按分デモ
- 対象Pool選択
- Relief Cash自動支払い
- Relief Receipt発行
- Sponsor Impact SBT更新
- 透明性ダッシュボード

MVPではやらないもの:

- 実際の外部DeFi運用
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
  -> up to 30% Yield Reserve

Yield Reserve
  -> Sui native staking first
  -> rewards to Operations Pool
  -> principal remains relief reserve

Disaster Payout
  -> matching Designated Pool first
  -> Main Pool backstop second
  -> proportional payout if insufficient

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
  -> proportional payout if insufficient
```

## 14. Pitch用表現

日本語:

> Sonariでは、指定寄付は半分を指定災害プールへ、半分をMain Poolへ入れます。災害時は指定プールから先に支払い、不足分をMain Poolが補填します。Main Poolの最低70%は即時支払い用に保持し、最大30%をYield Reserveとして運用できます。利回りはNautilus、インフラ、通知などのOperations Poolへ送られ、比率・運用先・使途はすべて透明化されます。

> 支払額は、災害Band、会員登録期間、不正リスク、Pool残高に基づいてPayoutPolicyで決まります。Poolが不足する場合は早い者勝ちではなく、対象者全体に比例配分します。

English:

> Sonari splits designated donations between the selected disaster pool and the Main Pool. When a verified disaster occurs, the matching designated pool pays first, and the Main Pool acts as a backstop. At least 70% of the Main Pool stays liquid for immediate payouts, while up to 30% can be allocated to a Yield Reserve. Yield funds Nautilus compute, infrastructure, and notifications through the Operations Pool, with all allocation ratios, strategies, and uses shown transparently.

> Payout amounts are determined by a transparent PayoutPolicy based on disaster band, membership age, fraud risk, and pool liquidity. If the pool is insufficient, Sonari distributes funds proportionally instead of relying on first-come-first-served claims.
