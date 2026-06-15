# Donation Flow

Sonari is a donation-backed aid system. It does not promise insurance-like payouts. Instead, Sui Move contracts hold donated USDC in transparent pools and apply fixed rules when a verified person claims support for a verified campaign.

This document explains where money goes, how payout amounts are calculated, and why recipients are not rewarded for applying earlier than others.

## 1. The Four Pools

| Pool | Role |
| --- | --- |
| Category Pool | A permanent pool for a support category, such as earthquake relief. It receives everyday donations and is the first source for immediate floor payouts. |
| Campaign Pool | A disaster-specific pool created automatically when a verified disaster becomes claimable. It receives donations for that disaster and funds later pro-rata payouts. |
| Main Pool | A platform-wide support pool. It receives unspecified donations, provides backup funding for floor payouts, and receives late or residual campaign funds. |
| Operations Pool | A pool for platform costs such as infrastructure, audits, and operations. It is funded only by the operations share of donations. |

The important separation is this:

- **Category Pool and Main Pool** fund the immediate minimum line of aid.
- **Campaign Pool** funds later distribution after the campaign donation window closes.
- **Operations Pool** is separated from support pools. There is no function for operators to withdraw from Main, Category, or Campaign pools for operations.

## 2. Donation Splits

Every donation is split by the contract at the moment of donation. The split is recorded in on-chain events.

| Donation target | Split |
| --- | --- |
| Specific disaster campaign | 90% Campaign / 5% Main / 5% Operations |
| Support category, such as earthquake relief | 90% Category / 5% Main / 5% Operations |
| Unspecified donation | 95% Main / 5% Operations |

Campaign donations also have an operations cap per campaign. After that cap is reached, the 5% operations share that would have gone to Operations is routed to Main instead. This prevents a single high-profile disaster from becoming an unlimited operations-fee source.

If a donation arrives for a campaign after the campaign donation window has ended, the campaign share is routed to Main. This keeps late money available for future aid instead of changing the rules of a campaign that has already closed.

## 3. Campaign Timeline

When a verified disaster is finalized, a Campaign is created automatically with fixed terms.

| Time | What happens |
| --- | --- |
| Day 0 | DisasterEvent and Campaign are created from a signed Nautilus result. |
| Day 0-21 | Eligible recipients can apply. |
| Day 0-30 | Donors can donate to the campaign. |
| Before Day 30 | Floor payout can be paid after the floor census is set. |
| Day 30+ | Unused floor budget is returned, and Round 1 campaign payout can be finalized lazily during claim. |
| Every 90 days after that | Additional campaign payout rounds can distribute remaining campaign funds. |

The terms are snapshotted when the Campaign is created. A later governance or operator decision cannot quietly change the payout ratio, claim window, or target amounts for that campaign.

## 4. Recipient Requirements

A recipient cannot claim only because a disaster happened nearby. A valid claim combines several checks:

| Requirement | Meaning |
| --- | --- |
| Membership | The claimant has an active Membership SBT. |
| Residence timing | The claimant registered a home cell before the disaster cutoff. |
| Affected area | The home cell is included in the disaster's affected-cells Merkle root. |
| Identity | The claimant has a verified identity result. The MVP live route is World ID. |
| Duplicate protection | The same membership lineage cannot claim twice for the same campaign/round. |

Raw personal data, identity documents, and addresses are not stored on-chain. The contract stores verification state, hashes, timestamps, and claim records.

## 5. Two-Stage Payout

Sonari pays relief in two stages.

### Stage 1: Floor Payout

The floor payout is an immediate minimum line of aid. It does **not** use the Campaign Pool because campaign donations are still being collected during the first 30 days.

Funding source:

```text
Category Pool first, then Main Pool as backup
```

The floor amount is fixed from a signed census result. The census counts how many pre-registered members are in each affected band. The contract verifies the signed census result but does not perform the full off-chain aggregation itself.

Core floor formulas:

```text
max_liability = sum(registered_count[band] * band_target[band])

floor_target = max_liability * floor_target_ratio_bps / 10_000

draw_category = min(floor_target, category_disposable / category_annual_event_divisor)

remaining = floor_target - draw_category

draw_main = min(remaining, main_disposable * floor_main_share_bps / 10_000)

floor_budget = draw_category + draw_main

floor_ratio_bps = min(floor_target_ratio_bps, floor_budget * 10_000 / max_liability)

floor_amount[band] = band_target[band] * floor_ratio_bps / 10_000
```

MVP constants from the contract design:

| Parameter | Value |
| --- | --- |
| `floor_target_ratio_bps` | 5000, meaning 50% of target |
| `category_annual_event_divisor` | 5 |
| `floor_main_share_bps` | 2000, meaning up to 20% of Main disposable balance |

Because `floor_amount[band]` is fixed after the signed census is accepted, the floor payout is not first-come-first-served.

### Stage 2: Campaign Payout

The campaign payout distributes the Campaign Pool after the 30-day donation window closes.

Funding source:

```text
Campaign Pool only
```

Category and Main do not top up campaign payout rounds. They are used for the immediate floor layer, not for later campaign distribution.

Core campaign round formulas:

```text
liability = sum(eligible_count[band] * band_target[band])

ratio = min(campaign_balance / liability, round_cap_multiplier)

payout[band] = band_target[band] * ratio
```

The round is finalized once for the time boundary, then every claimant in the same band receives the same saved payout amount for that round. If funds remain, another round can be finalized after the next 90-day interval.

## 6. Band Targets

The MVP uses three affected-area bands.

| Band | Target amount | Per-round cap |
| --- | --- | --- |
| Band 1 | 50 USDC | 150 USDC |
| Band 2 | 150 USDC | 450 USDC |
| Band 3 | 300 USDC | 900 USDC |

The target amount is not guaranteed. It is the reference amount used for proportional distribution.

If campaign donations are lower than total need, everyone in the same band receives the same percentage of the target. If campaign donations are high, each round is capped at three times the band target. Remaining funds can be distributed in later rounds.

## 7. Why This Is Fairer Than First-Come-First-Served

Sonari separates application timing from payout calculation:

- The floor amount is fixed from the signed affected-population census.
- The main payout amount is fixed at round finalization after the campaign donation window closes.
- Claiming earlier does not let one recipient drain the pool ahead of others in the same band.
- Duplicate membership claims are blocked.
- Payout events and receipts make every money movement inspectable.

This makes the system suitable for donation-backed aid, where trust depends on both transparent funding and transparent eligibility.

---

# 寄付と支援金の流れ（日本語）

Sonari は、寄付を原資とする支援システムです。保険のように支払いを保証するものではありません。Sui Move コントラクトが寄付された USDC を透明な Pool に保持し、検証済みの人が検証済み Campaign に対して claim した時に、固定ルールで支援金を支払います。

この文書では、お金がどこに入り、支払額がどう計算され、なぜ早い者勝ちにならないのかを説明します。

## 1. 4つの Pool

| Pool | 役割 |
| --- | --- |
| Category Pool | 地震支援など、支援カテゴリごとの常設 Pool。平常時寄付を受け取り、即時の床払いの第1財源になる。 |
| Campaign Pool | 検証済み災害ごとに自動作成される Pool。その災害向け寄付を受け取り、後日の按分払いに使う。 |
| Main Pool | プラットフォーム共通の支援 Pool。指定なし寄付、床払いの不足補填、遅延・残余資金の受け皿になる。 |
| Operations Pool | インフラ、監査、運用などの費用に使う Pool。寄付時の運営分だけが入る。 |

重要な分離は次の通りです。

- **Category Pool と Main Pool** は、即時の最低ライン支援に使う。
- **Campaign Pool** は、寄付期間終了後の按分払いに使う。
- **Operations Pool** は支援 Pool から分離する。運営が Main、Category、Campaign Pool から運営費を引き出す関数はない。

## 2. 寄付の分割

寄付は、寄付した瞬間にコントラクトで分割されます。分割結果は on-chain event に記録されます。

| 寄付先 | 分割 |
| --- | --- |
| 特定の災害 Campaign | 90% Campaign / 5% Main / 5% Operations |
| 地震支援などの Category | 90% Category / 5% Main / 5% Operations |
| 指定なし | 95% Main / 5% Operations |

Campaign 宛て寄付には、Campaign ごとの operations cap があります。上限到達後、本来 Operations に入る 5% は Main に送られます。これにより、1つの大きな災害が無制限の運営費源になることを防ぎます。

Campaign 寄付期間終了後にその Campaign 宛てに届いた寄付は、Campaign 取り分を Main に送ります。すでに閉じた Campaign のルールを後から変えず、次の支援に使える資金として残すためです。

## 3. Campaign のタイムライン

検証済み災害が finalized になると、固定条件を持つ Campaign が自動作成されます。

| 時期 | 内容 |
| --- | --- |
| Day 0 | 署名済み Nautilus result から DisasterEvent と Campaign が作られる。 |
| Day 0-21 | 資格ある受給者が申請できる。 |
| Day 0-30 | 寄付者が Campaign に寄付できる。 |
| Day 30 前 | floor census 確定後、床払いを受け取れる。 |
| Day 30 以降 | 未使用の床予算を返還し、claim 時に Round 1 の本払いを lazy finalize できる。 |
| 以後90日ごと | Campaign 残高があれば、追加 round を分配できる。 |

条件は Campaign 作成時に固定されます。後から governance や運営判断で、その Campaign の支払い比率、申請期間、目標額をこっそり変えることはできません。

## 4. 受給者の条件

近くで災害が起きただけでは claim できません。有効な claim には複数の検証が必要です。

| 条件 | 意味 |
| --- | --- |
| Membership | 申請者が active な Membership SBT を持つ。 |
| 居住登録時刻 | 災害 cutoff より前に home cell を登録している。 |
| 被災地域 | home cell が災害の affected-cells Merkle root に含まれる。 |
| 本人確認 | verified identity result を持つ。MVP の live route は World ID。 |
| 重複防止 | 同じ membership lineage は同じ campaign/round で二重 claim できない。 |

本人確認書類、住所、raw personal data は on-chain に保存しません。保存されるのは verification state、hash、timestamp、claim record です。

## 5. 2段階の支払い

Sonari の支援金は2段階で支払われます。

### Stage 1: 床払い

床払いは、即時の最低ライン支援です。Campaign Pool は最初の30日間まだ寄付を集めている途中なので使いません。

財源:

```text
まず Category Pool、足りなければ Main Pool
```

床払い額は署名済み census result から固定されます。census は、災害前に登録済みの member が各 affected band に何人いるかを数えます。コントラクトは署名済み census result を検証しますが、全件集計自体は on-chain では行いません。

主要な床払い計算式:

```text
max_liability = sum(registered_count[band] * band_target[band])

floor_target = max_liability * floor_target_ratio_bps / 10_000

draw_category = min(floor_target, category_disposable / category_annual_event_divisor)

remaining = floor_target - draw_category

draw_main = min(remaining, main_disposable * floor_main_share_bps / 10_000)

floor_budget = draw_category + draw_main

floor_ratio_bps = min(floor_target_ratio_bps, floor_budget * 10_000 / max_liability)

floor_amount[band] = band_target[band] * floor_ratio_bps / 10_000
```

MVP の contract design 上の主な定数:

| Parameter | Value |
| --- | --- |
| `floor_target_ratio_bps` | 5000、つまり目標額の50% |
| `category_annual_event_divisor` | 5 |
| `floor_main_share_bps` | 2000、つまり Main 可処分残高の最大20% |

`floor_amount[band]` は署名済み census が受理された後に固定されるため、床払いは早い者勝ちになりません。

### Stage 2: Campaign 按分払い

Campaign 按分払いは、30日の寄付期間が終わった後に Campaign Pool を分配します。

財源:

```text
Campaign Pool のみ
```

Category と Main は Campaign payout round を補填しません。これらは即時の床払いのために使います。

主要な Campaign round 計算式:

```text
liability = sum(eligible_count[band] * band_target[band])

ratio = min(campaign_balance / liability, round_cap_multiplier)

payout[band] = band_target[band] * ratio
```

round は時間境界ごとに1度だけ finalize され、同じ band の claimant はその round で同じ保存済み支払額を受け取ります。資金が残る場合は、90日後以降に次の round を分配できます。

## 6. Band 目標額

MVP は3つの affected-area band を使います。

| Band | 目標額 | 1 round の上限 |
| --- | --- | --- |
| Band 1 | 50 USDC | 150 USDC |
| Band 2 | 150 USDC | 450 USDC |
| Band 3 | 300 USDC | 900 USDC |

目標額は保証額ではありません。比例分配の基準額です。

Campaign 寄付が必要額より少ない場合、同じ band の全員が同じ割合で受け取ります。Campaign 寄付が多い場合でも、1 round あたり band 目標額の3倍を上限にします。残りは後続 round で分配できます。

## 7. なぜ早い者勝ちではないか

Sonari は申請タイミングと支払額計算を分離しています。

- 床払い額は署名済み affected-population census から固定される。
- 本払い額は Campaign 寄付期間終了後、round finalize で固定される。
- 早く claim した人が同じ band の他の人より先に Pool を取り切ることはできない。
- membership の重複 claim は防止される。
- payout event と receipt により、すべてのお金の動きを検査できる。

これにより Sonari は、資金の透明性と受給資格の透明性が同時に必要な寄付型支援に適した仕組みになります。
