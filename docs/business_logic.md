# Sonari Business Logic / 事業・資金設計メモ

## 1. 基本方針

Sonari は、Nautilus で受取対象を検証できる汎用寄付プラットフォームとして設計する。災害支援は最初のユースケースだが、事業ロジックの中心は災害専用の支払いではなく、寄付 Pool、Program / Campaign、Membership Pass、Nautilus 署名済み metadata、Claim / Payout の組み合わせである。

Sonari は保険商品ではない。支払い保証をしない。Verification Fee は支援金の購入や継続的な掛け金ではなく、検証、不正対策、運営費のための一度きりの費用である。

重要な前提:

- 支払い保証をしない
- 保険料・掛け金という表現を使わない
- Verification Fee は Operations Pool に入り、Relief / Campaign payout 原資ではない
- 寄付金の流れ、Pool 残高、budget、支払い履歴をダッシュボードで透明化する
- Nautilus と Sui Move により、条件付き支払いを検証可能にする
- raw email、phone、GPS 履歴、端末情報、住所、学籍番号などの個人情報をオンチェーンに出さない

## 2. Program / Campaign Model

`Program` は「何のための寄付で、誰が対象で、どの検証を使い、どの Pool から支払うか」を定義する。

例:

- Disaster Relief Program
- Student Aid Program
- Regional Support Program
- Sponsor Scholarship Program

`Campaign` は Program 配下の具体的な実行単位である。Disaster Relief では特定の地震イベントやスポンサー支援、Student Aid では学期・学校・スポンサー別の支援に使える。

```text
Program
  -> Campaign
  -> Pool
  -> PayoutPolicy
  -> Claim / Receipt
```

Program / Campaign は以下を持つ。

| 項目 | 役割 |
| --- | --- |
| 対象者種別 | resident、student、disaster affected resident など |
| 必須 Pass metadata | residence、student、risk、confidence など |
| 必須 verifier family | disaster、residence、student など |
| Pool 方針 | Main Pool、Designated Pool、Campaign Pool、backstop |
| PayoutPolicy | eligibility tier、risk、confidence、budget cap |
| Claim window | Claim 可能期間 |

## 3. 資金プール構成

Sonari の資金は、目的別に分離する。

### 3.1 Main Pool / General Relief Pool

用途を限定しない共通支援プール。

役割:

- 未指定寄付の受け皿
- 各 Designated / Campaign Pool 不足時の補填
- 予測できない支援需要への流動性
- Sonari 全体の緊急流動性

Main Pool は、Sonari の中心となる支援原資であり、災害種別や Program を限定しない。ただし、1 Campaign で使い切らないよう Future Disaster Reserve / Future Program Reserve を残す。

### 3.2 Designated / Campaign Pools

災害種別、地域、企業キャンペーン、Student Aid など、用途を指定した支援プール。

例:

- Earthquake Pool
- Flood Pool
- Typhoon Pool
- Wildfire Pool
- Region Pool
- Sponsor Campaign Pool
- Student Aid Campaign Pool

Designated / Campaign Pool は、寄付者・企業の意図を反映するためのプールである。Claim 時は、該当する Pool から先に支払い、不足時のみ Main Pool backstop を使う。

### 3.3 Operations Pool

運営費用のためのプール。

用途:

- Nautilus / TEE 実行費
- Cloudflare Worker / D1 / Queue
- AWS runner / Nitro Enclaves
- 監視、通知、サポート
- セキュリティ、監査、保守開発

Operations Pool の原資:

- Verification Fee
- Operations Donation
- Main Pool Yield Reserve の利回り
- 将来的な Platform Sponsorship

Operations Pool は Relief / Campaign Pool と分離する。Operations Pool の残高は Claim payout に使わない。

## 4. 寄付の配分ルール

既存の資金設計を正として維持する。

### 4.1 General Donation

用途指定のない寄付。

```text
General Donation
  -> 100% Main Pool
```

### 4.2 Designated Donation

企業や個人が、災害種別、地域、学校支援、キャンペーンなどを指定して行う寄付。

MVP では以下の配分を基本とする。

```text
Designated Donation
  -> 50% Designated Relief Pool or Campaign Pool
  -> 50% Main Pool
```

理由:

- 指定した目的への支援意図を反映できる
- Main Pool にも流動性が残り、他 Campaign や不足時補填に使える
- 特定 Pool だけが偏って Main Pool が枯れる問題を避けられる

将来的には、企業向けに Strict Designated Donation を用意してもよい。

```text
Strict Designated Donation
  -> 100% Designated / Campaign Pool
```

MVP では複雑化を避けるため、Designated Donation は 50% / 50% で扱う。

### 4.3 Operations Donation

運営支援目的の寄付。

```text
Operations Donation
  -> 100% Operations Pool
```

Operations Donation は Relief payout 原資ではない。

## 5. Membership Pass

Sonari の受取者は、Program 種別にかかわらず `MembershipPass` を持つ。Pass は全受取者必須の準 SBT であり、通常 transfer できない。wallet 移行は Nautilus 署名付き migration result がある場合だけ許可する。

Pass が持つ考え方:

| 項目 | 内容 |
| --- | --- |
| `pass_lineage_id` | wallet 移行後も同一 Pass 系譜を追跡する ID |
| owner / payout address | 支払い先 wallet |
| status | active、suspended、revoked、migrated |
| metadata | residence、student、risk、confidence などの bucket / hash / timestamp |
| migration | Nautilus 署名付き result のみ許可 |

Pass は raw 個人情報を持たない。支払い判定に使う metadata は Nautilus 署名済み update だけを信頼する。

## 6. Verification Fee

ユーザーは、最初の Pass 発行や高信頼 metadata 取得時に一度きりの Verification Fee を支払うことがある。

Verification Fee の位置づけ:

- 支払い保証ではない
- 支援金の購入ではない
- 継続的な掛け金ではない
- 本人性、地域、学生状態、不正リスクなどを検証するための費用
- Nautilus 検証、通知、最低限の登録処理を支える補助費用
- 複数アカウント大量作成への経済的ハードル
- Operations Pool の原資

Verification Fee を払ったことは、どの Program でも payout を保証しない。Claim は Program 条件、Pass metadata、Nautilus verifier result、Pool 残高、CampaignBudget に依存する。

## 7. Residence Verification

Residence verifier は、ユーザーが対象地域に関係することを Nautilus 内で検証し、Pass metadata を更新する。

### 7.1 Web MVP Confidence Scoring

MVP では、Web で提出される複数の低侵襲 signal を使い、coarse な residence confidence を作る。

例:

- self-declared region
- wallet / Pass age
- coarse check-in history hash
- local interaction proof hash
- region change frequency
- previous verified residence freshness

Nautilus は evidence snapshot を秘匿して検証し、オンチェーンには以下だけを出す。

```text
ResidenceMetadataUpdate {
  pass_lineage_id
  verified_residence_cell
  residence_confidence
  risk_bucket
  evidence_snapshot_hash
  issued_at_ms
  expires_at_ms
}
```

オンチェーンに出さないもの:

- raw phone number
- GPS history
- device id / fingerprint
- IP history
- detailed address
- raw document image

### 7.2 Disaster Claim での使い方

Disaster Relief Program では、Disaster Oracle が作る `affected_cells_root` と Pass の `verified_residence_cell` を合成する。

```text
DisasterEvent.affected_cells_root
  + AffectedCellLeaf proof
  + MembershipPass.verified_residence_cell
  -> disaster claim eligibility
```

Claim では `leaf.h3_index == verified_residence_cell` を検証し、cell band を eligibility tier として使う。

## 8. Student Verification

Student verifier は、学生状態や学校・地域との関係を Nautilus 内で検証し、Student Aid Program の Claim に使う Pass metadata を更新する。

```text
StudentMetadataUpdate {
  pass_lineage_id
  student_status
  school_region_hash
  student_confidence
  risk_bucket
  evidence_snapshot_hash
  issued_at_ms
  expires_at_ms
}
```

オンチェーンに出さないもの:

- raw school email
- student id
- transcript
- enrollment certificate image
- legal name
- detailed address

Student Aid Program の Claim では、Pass が active で、Student metadata が有効期限内で、Campaign 条件に合い、risk bucket が許容範囲であることを検証する。

## 9. Claim / Payout Logic

Generic Claim は以下を検証する。

| 分類 | 条件 |
| --- | --- |
| Program / Campaign | active、Claim window 内、required metadata が定義通り |
| Pass | active、owner / payout address が一致、`pass_lineage_id` が未 Claim |
| Metadata | Nautilus 署名済み、期限内、Program が要求する confidence / risk を満たす |
| Eligibility | `EligibilityResult`、Merkle proof、Disaster `AffectedCellLeaf` など Program 固有条件 |
| Payout | PayoutPolicy、Pool 残高、CampaignBudget、reserve を超えない |

支払いは早い者勝ちに見えすぎないよう CampaignBudget で cap する。MVP では全対象者 target amount 合計に基づく完全な pro-rata は Future とし、Claim ごとに remaining budget 内へ cap、または支払い不可にする。

### 9.1 PayoutPolicy

```text
target_amount =
  base_amount_by_eligibility_tier
  * membership_multiplier
  * confidence_multiplier
  * risk_multiplier
```

上限:

```text
target_amount <= user_max_amount
target_amount <= policy_max_amount
target_amount <= campaign_budget_remaining
target_amount <= available_pool_balance
```

Disaster Relief MVP の既存値:

```text
Band 1: $50
Band 2: $150
Band 3: $300

登録30日未満: 0
登録30〜90日: 0.5
登録90日以上: 1.0

Low risk: 1.0
Medium risk: 0.5
High risk: 0
```

### 9.2 CampaignBudget

既存の EventBudget 設計を汎用 `CampaignBudget` として扱う。Disaster Relief では 1 DisasterEvent に紐づく CampaignBudget が EventBudget の役割を持つ。

```text
future_reserve_floor = main_pool_total * 50%
liquid_reserve_target = main_pool_total * 70%
main_pool_spendable = max(0, main_pool_total - future_reserve_floor)
main_backstop_budget = min(liquid_reserve_target * 20%, main_pool_spendable)
designated_budget = matching_designated_pool_balance * 80%
campaign_budget = designated_budget + main_backstop_budget
```

支払い順序:

```text
1. matching Designated / Campaign Pool
2. Main Pool backstop
3. CampaignBudget 不足時は remaining budget 内へ cap、または支払い不可
```

## 10. Main Pool 70% / 15% / 15% 方針

MVP では実資金運用は行わないが、既存の資金設計として以下を維持する。

```text
Main Pool
  -> 70% Liquid Relief Reserve
  -> 15% SUI Native Staking Reserve
  -> 15% Scallop Stablecoin Strategy
```

### 10.1 Liquid Relief Reserve

Main Pool の最低 70% を即時支払い用として保持する。

用途:

- Disaster Relief や Student Aid などの即時支払い
- Designated / Campaign Pool 不足時の補填
- 予測できない支援需要への対応

### 10.2 Yield Reserve

Main Pool の最大 30% を運用枠として設計上扱う。

重要なルール:

- 30% は上限であり、固定義務ではない
- 元本は Main Pool の支援原資として扱う
- 利回りは Operations Pool へ送る
- MVP では実入金せず、strategy 表示と dashboard 表示に留める

## 11. 企業スポンサー向け価値

企業スポンサーは、General Donation、Designated Donation、Campaign Donation を選べる。

### 11.1 General Donation

用途を限定せず、Main Pool へ寄付する。

メリット:

- 複数 Program の不足時 backstop に貢献できる
- Sonari 全体の緊急流動性に貢献できる
- Main Pool contribution として可視化できる

### 11.2 Designated / Campaign Donation

地震、洪水、地域、学生支援、企業キャンペーンなどを指定して寄付する。

MVP 配分:

```text
50% Designated / Campaign Pool
50% Main Pool
```

メリット:

- 特定目的への支援意思を示せる
- Main Pool にも貢献し、全体の支援継続性を支えられる
- SponsorProfile で内訳を表示できる

表示例:

```text
Sponsor A
Total donated: $10,000
Earthquake Campaign Pool: $5,000
Main Pool contribution: $5,000
People reached: 320
Programs supported: 2
```

## 12. 透明性ダッシュボード

表示すべき項目:

- Main Pool 残高
- Designated / Campaign Pool 別残高
- Operations Pool 残高
- Liquid Relief Reserve 比率
- Yield Reserve 比率
- Program / Campaign budget
- Claim count
- 支払い額
- Sponsor 別寄付額
- Sponsor Impact
- Nautilus verifier result の件数と freshness

これにより、寄付者・企業・受取者が「何に使われたか」を確認できる。

## 13. MVPで見せる範囲

ハッカソン MVP では、災害支援を最初の Program として見せる。ただし説明の本質は、Nautilus で現実世界の条件を検証し、Sui Move 上の Program / Pool / Pass / PayoutPolicy が支払いを実行する汎用 Programmable Donation Platform である。

良い説明:

```text
Recipients hold a Membership Pass.
Nautilus verifies the metadata required by each Program.
When a Campaign condition is met, Sonari checks eligibility and sends funds from transparent on-chain pools.
```

日本語:

```text
受取者はMembership Passを持ちます。
NautilusがProgramごとに必要なmetadataを検証します。
Campaign条件が満たされると、SonariはEligibilityを確認し、
オンチェーンPoolから支援金を支払います。
```

Disaster Relief demo の流れ:

```text
Sponsor donates to Earthquake Campaign
  -> 50% goes to Earthquake Pool
  -> 50% goes to Main Pool
  -> earthquake event is verified by Nautilus Disaster Oracle
  -> residence metadata is verified by Nautilus Membership Verifier
  -> DisasterEvent affected_cells_root and Pass verified_residence_cell match
  -> PayoutPolicy calculates payout amount
  -> Earthquake Pool pays first
  -> Main Pool covers shortage if needed
  -> ClaimReceipt is issued
```

Student Aid demo の流れ:

```text
Sponsor creates Student Aid Campaign
  -> funds go to Campaign Pool and Main Pool
  -> student metadata is verified by Nautilus Membership Verifier
  -> active MembershipPass satisfies Campaign condition
  -> PayoutPolicy calculates aid amount
  -> Campaign Pool pays first
  -> ClaimReceipt is issued
```

## 14. Future

- Strict Designated Donation
- Flexible Relief
- Emergency Override
- full pro-rata payout
- 複数 verifier quorum
- 本番 KYC / 学校 API / 住所 API 接続
- fiat 決済
- DAO governance
- 法定寄付領収書
- SUI staking / Scallop strategy の実運用

## 15. まとめ

Sonari は、企業や個人の寄付を Sui 上の透明な Pool TVL に変え、Nautilus で検証された現実世界の条件に応じて Program / Campaign 単位で支払いを実行する。災害支援は最初の強いユースケースであり、同じ Membership Pass と verifier result の仕組みを Student Aid や地域支援にも拡張できる。
