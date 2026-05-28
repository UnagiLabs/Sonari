# Sonari Business Logic / 事業・資金設計メモ

## 1. 基本方針

Sonari は保険商品ではない。
支払いを保証しない。
寄付型の Programmable Payment infrastructure として扱う。

MVP の主役は、次の 3 つである。

- 透明な Relief Pool
- Nautilus による災害と本人確認の検証
- Sui Move による条件付き支払い

支払い対象は、災害前に作成され、災害前に居住セルを登録した
Membership SBT に限定する。
さらに、KYC または World ID のどちらかで本人確認済みである必要がある。

オンチェーンには、生の個人情報を保存しない。
KYC の詳細、World ID proof の詳細、credential の原文、
本人確認書類画像、住所、電話、GPS 履歴は出さない。

## 2. MVP の本人確認ルール

MVP の本人確認ルートは 2 つだけにする。

```text
未認証
  -> Claim 不可

KYC verified
  -> 100% Claim 可

World ID verified
  -> 100% Claim 可
```

Humanity 系の別 credential は MVP 対象にしない。
EVM address 連携、しきい値判定、有効期限確認、
Sui address との対応確認が増えるためである。

本人確認の結果は Nautilus が検証する。
Move contract は、Nautilus が署名した最小限の結果だけを信頼する。

Membership SBT には、次のような状態を持たせる。

```text
MembershipSBT {
  owner: address
  status

  account_created_at_ms
  home_cell
  home_cell_registered_at_ms

  identity_verified: bool
  identity_provider_mask: u8
  identity_verified_at_ms
  identity_expires_at_ms

  terms_version
  signed_statement_hash
}
```

居住セルは、ユーザーの自己申告で登録する。
MVP では、厳密な住所証明や居住実態の証明として扱わない。
登録する `home_cell` は H3 resolution 7 のセルに固定する。
1 つの active な Membership SBT は、同時に 1 つの active な居住セルだけを持つ。

居住セルは、Claim eligibility の地域判定に使う。
災害ごとの affected cells と照合できる粒度に揃えるため、
MVP では resolution を混在させない。
海のみのセルなど、居住地として自然でないセルの扱いは、
登録 UI と verifier 側の入力検証で制限する対象である。
この文書変更だけでは、contract や schema の変更を定義しない。

`identity_provider_mask` は、本人確認 provider を表す。

```text
KYC = 1
World ID = 2
KYC + World ID = 3
```

## 3. Claim 対象条件

Claim 可能な Membership SBT は、すべての条件を満たす必要がある。

- DisasterEvent が finalized 済みである。
- Membership SBT が active である。
- `account_created_at_ms < disaster_cutoff_time` を満たす。
- `home_cell_registered_at_ms < disaster_cutoff_time` を満たす。
- 登録済み居住セルが affected cells に含まれる。
- `identity_verified == true` である。
- 本人確認時の duplicate key がこの Membership SBT に紐づいている。
- 受取先は Membership SBT owner の Sui address である。

`disaster_cutoff_time` は、原則として次の早い方を使う。

- `earthquake_occurred_at`
- Sonari の candidate detected time

災害発生時刻は cutoff の例または source であり、
用語としては `disaster_cutoff_time` を canonical に使う。
finalized time は cutoff に使わない。
地震発生後から finalized までの間に、駆け込み登録できるためである。
災害後に居住セルを変更しても、その災害の Claim 対象にはならない。
将来、より厳しくする場合は grace period を置き、
`last_changed_at_ms < disaster_cutoff_time - grace_period_ms` のように判定できる。
MVP では grace period の具体値をまだ決めない。

MVP では、GPS 履歴、IP geolocation、VPN detection、住所証明、
厳密な居住証明を Claim 条件に含めない。
これらはプライバシー、誤判定、実装複雑性の負担が大きいためである。

## 4. 支払額の考え方

MVP では、本人確認の種類で支給率を変えない。
KYC と World ID はどちらも満額ルートである。

支払額は、災害の強さと Pool / CampaignBudget の制約で決める。
本人確認の段階評価や不正評価の段階で金額を減らさない。

基本の一時支援額は次を目安にする。

```text
Band 1: $50
Band 2: $150
Band 3: $300
```

Pool が不足する場合は、CampaignBudget の中で支払う。
将来、対象者全体を見た按分を追加できる。

## 5. 受取先

MVP では、別の受取先を持たない。

```text
payout recipient = Membership SBT owner Sui address
```

銀行口座、外部ウォレット、代理受取先は MVP 外である。
これにより、本人確認済み SBT と受取先の関係を単純に保つ。

## 6. duplicate key

同一 provider 内の重複登録は防ぐ。

```text
IdentityRegistry {
  used_kyc_keys: Table<hash, membership_id>
  used_world_id_keys: Table<hash, membership_id>
}
```

KYC の duplicate key は、provider 側の一意 ID を salt 付き hash にする。
World ID の duplicate key は、app、action、nullifier から作る。

```text
kyc_duplicate_key = hash(kyc_provider_id, provider_user_unique_id)
world_duplicate_key = hash(world_app_id, action, nullifier)
```

同じ provider 内で duplicate key が別 SBT に使用済みなら、
新しい Membership SBT へ本人確認済み状態を付与しない。
Claim 時には、登録済み duplicate key がこの Membership SBT に
紐づいていることを確認する。

## 7. KYC と World ID をまたぐ二重利用

KYC の subject と World ID の nullifier は別物である。
Sonari だけで同一人物だと完全判定することは難しい。

MVP では、provider をまたぐ二重アカウントの完全排除は行わない。
代わりに、登録時と Claim 時に明示的な同意を求める。

ユーザーには次を表示する。

- 他に有効な Sonari Membership SBT を保有していないこと。
- 同一災害で複数の Membership SBT から Claim しないこと。
- 虚偽申告や複数 Claim は停止や返還請求の対象になり得ること。

この内容に対して Sui wallet 署名を求める。
オンチェーンには規約本文ではなく、次だけを保存する。

- `terms_version`
- `signed_statement_hash`

## 8. 資金プール

Sonari の資金は目的別に分ける。

| Pool | 用途 |
| --- | --- |
| Main Pool | 用途を限定しない共通支援プール |
| Designated Relief Pool | 災害種別、地域、スポンサーなどの指定プール |
| Operations Pool | Nautilus、インフラ、監視、サポートなどの運営費 |

寄付の基本ルールは次の通りである。

```text
General Donation
  -> 100% Main Pool

Designated Donation
  -> 50% Designated Relief Pool
  -> 50% Main Pool

Operations Donation
  -> 100% Operations Pool
```

Relief Pool と Operations Pool は混同しない。
支援元本は、支援のために使う。

## 9. 災害支払いの流れ

MVP の地震支払いは、次の流れで行う。

```text
Sponsor donates to Earthquake Pool
  -> Earthquake event is verified by Nautilus
  -> affected cells root is stored on-chain
  -> user submits Claim
  -> Move checks Membership SBT and affected cell
  -> Move checks identity_verified
  -> Earthquake Pool pays first
  -> Main Pool covers allowed shortage
  -> Relief Receipt is issued
```

Move contract は worker、relayer、dapp を信頼しない。
署名済み payload、on-chain state、SBT owner だけを使って検証する。

## 10. 現在の Move 実装との差分

この文書は target MVP 仕様である。
現在の Move 実装には、旧設計の名残がある。

follow-up では次を直す必要がある。

- 登録時の fee 前提を外す。
- Membership SBT から別受取先の概念を外す。
- Claim 条件へ `identity_verified` を追加する。
- `account_created_at_ms` を保存し、cutoff 判定に使う。
- `home_cell_registered_at_ms` を保存し、cutoff 判定に使う。
- KYC / World ID duplicate key registry を追加する。
- 支払額計算から本人確認の段階評価に基づく係数を外す。

## 11. MVP ピッチでの表現

短く伝える場合は、次の説明を使う。

English:

> Sonari turns disaster relief donations into transparent pools on Sui.
> Nautilus verifies real-world disasters and identity status.
> Sui Move pays only verified Membership SBT owners who were registered
> in affected cells before the disaster cutoff.

日本語:

> Sonari は、災害支援の寄付を Sui 上の透明な Pool に変えます。
> Nautilus が災害と本人確認を検証します。
> Sui Move は、災害前に対象地域へ登録済みで、
> KYC または World ID で確認済みの Membership SBT owner にだけ支払います。
