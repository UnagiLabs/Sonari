# Disaster Funding Model / 災害時の資金設計案

この文書は、災害発生時に Sonari の寄付資金をどう使うかを整理する設計メモである。
現時点では README へ入れる最終文言ではなく、pool 設計と計算式を詰めるための proposal として扱う。

## 1. 設計の目的

Sonari は保険ではなく、寄付による支援インフラである。
そのため、1 回の大きな地震で長期的な支援原資が空になる設計は避ける。

災害時の資金設計では、次を同時に満たす必要がある。

- できるだけ早く初期支援を出す。
- 被害が大きい人にはより多く支援する。
- Earthquake Pool と Main Pool を 1 回の災害で使い切らない。
- 災害後に集まる追加寄付を、その災害の支援に使えるようにする。
- 早く claim した人だけが有利になる配分を避ける。

## 2. Pool の役割

| Pool | 役割 | 災害時の扱い |
| --- | --- | --- |
| Main Pool | 用途を限定しない共通支援プール | 最後の backstop。使える割合は小さく制限する。 |
| Earthquake Pool | 地震カテゴリ全体の事前支援プール | 地震支援の主原資。ただし 1 災害ごとの使用上限を設ける。 |
| Event Emergency Pool | 特定の災害発生後に作る追加支援プール | その災害専用の top-up 原資として使う。 |
| Operations Pool | 運営、Nautilus、監視、サポート費用 | Relief payout には使わない。 |

## 3. 災害前の寄付

災害前の寄付は、長期的な支援原資を作るために使う。

```text
General Donation
  -> Main Pool

Earthquake / Designated Donation
  -> Earthquake Pool
  -> Main Pool

Operations Donation
  -> Operations Pool
```

Earthquake / Designated Donation を Earthquake Pool だけに入れると、特定カテゴリの支援力は上がる。
一方で Main Pool にも一部を残すと、他地域・他災害・将来災害への柔軟性を保てる。
具体的な split は policy として管理する。

## 4. 災害発生後の基本フロー

```text
1. 地震が発生する
2. Nautilus が DisasterEvent と affected_cells_root を finalized する
3. 対象 campaign を開く
4. Earthquake Pool から event budget を割り当てる
5. Main Pool から小さな backstop budget を割り当てる
6. 必要なら Event Emergency Pool を作成し、追加寄付を受け付ける
7. Move が claim 条件と budget を検証して支払う
8. 支払いごとに ClaimReceipt / Impact Receipt を作る
```

Nautilus は災害と対象セルを検証する。
Move contract は最終的なお金の移動を強制する。
frontend、worker、relayer、storage は eligibility や支払額を決める主体として信頼しない。

## 5. 1 災害ごとの Earthquake Pool 使用上限

Earthquake Pool は地震カテゴリ全体の長期原資である。
そのため、1 回の地震に割り当てる額には上限を設ける。

```text
earthquake_event_budget =
  min(
    EarthquakePool.balance * earthquake_event_spend_cap_bps,
    EarthquakePool.balance - earthquake_pool_reserve_floor
  )
```

例:

```text
earthquake_event_spend_cap_bps = 20%
earthquake_pool_reserve_floor = EarthquakePool.balance の 40%
```

この場合、1 回の地震では Earthquake Pool の最大 20% までしか使わない。
また、どのような場合でも 40% は将来の地震支援のために残す。

## 6. Main Pool backstop の使用上限

Main Pool は、地震以外も含む共通支援原資である。
そのため、Earthquake Pool よりさらに厳しく使う。

```text
main_backstop_budget =
  min(
    MainPool.balance * main_backstop_cap_bps,
    MainPool.balance - main_pool_reserve_floor
  )
```

例:

```text
main_backstop_cap_bps = 5%
main_pool_reserve_floor = MainPool.balance の 70%
```

Main Pool は、Earthquake Pool が足りない場合の補助として使う。
ただし、将来の支援や他カテゴリの支援を壊さないよう、1 災害あたりの使用量を小さく制限する。

## 7. 支払額の計算

基本支払額は affected cell の band で決める。

```text
Band 1: 50 USDC
Band 2: 150 USDC
Band 3: 300 USDC
```

ただし、pool を守るため、実際の支払額は event budget と対象者数で cap する。

単純な式は次の通り。

```text
per_recipient_amount =
  min(
    band_base_amount,
    event_budget / eligible_recipient_count
  )
```

ただし、被害の強さを反映するには、band ごとに weight を付ける方が自然である。

```text
weighted_eligible_units =
  count_band1 * weight1
  + count_band2 * weight2
  + count_band3 * weight3

unit_amount =
  event_budget / weighted_eligible_units

band1_amount = min(50 USDC, unit_amount * weight1)
band2_amount = min(150 USDC, unit_amount * weight2)
band3_amount = min(300 USDC, unit_amount * weight3)
```

例:

```text
weight1 = 1
weight2 = 3
weight3 = 6
```

この方式では、被害 band が高い対象者ほど多く受け取る。
一方で、対象者数が多い災害では 1 人あたりの支払額が自動的に下がるため、pool が空になりにくい。

## 8. 計算例

```text
Earthquake Pool balance = 1,000,000 USDC
earthquake_event_spend_cap = 20%
earthquake_pool_reserve_floor = 40%

earthquake_event_budget =
  min(1,000,000 * 20%, 1,000,000 - 400,000)
  = min(200,000, 600,000)
  = 200,000 USDC
```

対象者:

```text
Band 1: 1,000 人
Band 2: 500 人
Band 3: 100 人
```

weight:

```text
Band 1 = 1
Band 2 = 3
Band 3 = 6
```

```text
weighted_eligible_units =
  1,000 * 1
  + 500 * 3
  + 100 * 6
  = 3,100

unit_amount =
  200,000 / 3,100
  = 約 64.5 USDC
```

支払額:

```text
Band 1 = min(50, 64.5 * 1) = 50 USDC
Band 2 = min(150, 64.5 * 3) = 150 USDC
Band 3 = min(300, 64.5 * 6) = 300 USDC
```

この例では、対象者全員に基本支払額を満額出せる。

対象者が 10 倍の場合:

```text
weighted_eligible_units = 31,000
unit_amount = 200,000 / 31,000 = 約 6.45 USDC

Band 1 = 6.45 USDC
Band 2 = 19.35 USDC
Band 3 = 38.7 USDC
```

支払額は下がるが、Earthquake Pool は将来災害のために残る。

## 9. Event Emergency Pool と top-up round

地震発生後、その災害専用の Event Emergency Pool を作る。
この pool は、災害後に集まる追加寄付を受け入れるためのもの。

Event Emergency Pool は eligibility rule を変えない。
つまり、追加寄付が集まっても「誰が対象か」は変えない。
変えるのは、支払対象者に追加で配れる金額だけである。

top-up は round 単位で行う。

```text
Top-up Round N:
  対象者 = round 開始時点で支払対象として確定している人全員
  原資 = Event Emergency Pool のうち、この round に割り当てた金額
  支払い = policy に基づいて対象者へ按分
```

重要なのは、すでに claim した人だけを対象にしないこと。
その時点で支払対象として確定している人全員を対象にする。

```text
top_up_round_budget =
  EventEmergencyPool.available_balance * round_distribution_bps
```

例:

```text
round_distribution_bps = 70%
```

この場合、round ごとに Event Emergency Pool の 70% を配り、30% は次 round、失敗 claim、調整用に残す。

より単純な MVP 案としては、claim window 終了後に Event Emergency Pool 残高を対象者で按分する方式もある。

## 10. 支払い優先順位

災害時の支払い優先順位は次の通り。

```text
1. Earthquake Pool の event budget
2. Main Pool の backstop budget
3. Event Emergency Pool の top-up round
```

初回支援は Earthquake Pool と Main Pool から出す。
災害後に集まる追加寄付は Event Emergency Pool から top-up として出す。

Event Emergency Pool はその災害専用なので、長期 reserve を持つ Main Pool / Earthquake Pool とは性質が異なる。
ただし、公平性のため、配分は round と policy で制御する。

## 11. README 向けの短い説明案

English:

```md
Sonari avoids draining long-term relief reserves in a single event. Each disaster receives a capped campaign budget from the Earthquake Pool, plus a smaller policy-controlled backstop from the Main Pool. After a disaster is finalized, Sonari can open an event-specific Emergency Pool for additional donations. Those donations do not change who is eligible; they are distributed through top-up rounds to everyone eligible at the time each round opens.
```

日本語:

```md
Sonari は、1 回の災害で長期的な支援原資が空にならないように設計する。各災害には Earthquake Pool から上限付きの campaign budget を割り当て、Main Pool はより小さな policy-controlled backstop として使う。災害が finalized された後は、その災害専用の Emergency Pool を開き、追加寄付を受け付けられる。追加寄付は eligibility rule を変えず、各 top-up round の開始時点で支払対象として確定している人全員へ配分する。
```
