# Sonari Sui Contracts 要件定義

## 1. Overview

Sonari contracts は、寄付 Pool、Program、Membership SBT、
DisasterEvent、Claim、Receipt を管理する。
災害支援は最初の Program であり、汎用の支援基盤として設計する。

Sonari は保険ではない。
DonorPass や Membership SBT は支払い保証を与えない。

MVP の受取者条件は単純にする。
KYC または World ID で本人確認済みの Membership SBT owner だけが
Claim できる。

## 2. 中心概念

| Concept | 役割 |
| --- | --- |
| `Program` | 支援目的、Claim 条件、Pool 方針を束ねる |
| `Campaign` | Program 配下の実行単位 |
| `Pool` | Main、Designated、Operations などの資金管理 |
| `MembershipSBT` | 受取者向け owned SBT |
| `IdentityRegistry` | KYC / World ID の provider 内 duplicate key を管理 |
| `DisasterEvent` | Nautilus が finalized した災害 event |
| `PayoutPolicy` | Band 別金額と CampaignBudget 制約を管理 |
| `ClaimReceipt` | 支払い結果を記録する receipt |

## 3. Membership SBT

Membership SBT は `has key` only の owned object とする。
通常 transfer API は提供しない。

target fields:

```text
MembershipSBT {
  owner: address
  status: u8

  account_created_at_ms: u64
  home_cell: u64
  home_cell_registered_at_ms: u64

  identity_verified: bool
  identity_provider_mask: u8
  identity_verified_at_ms: u64
  identity_expires_at_ms: u64

  terms_version: u64
  signed_statement_hash: vector<u8>
}
```

`identity_provider_mask`:

```text
KYC = 1
World ID = 2
KYC + World ID = 3
```

raw KYC data、World ID proof detail、credential detail、
document image、phone、GPS history、detailed address は保存しない。

`home_cell` は、ユーザーの自己申告による居住セルである。
contract-facing な要件として、H3 resolution 7 のセルだけを扱う。
1 つの active な Membership SBT は、同時に 1 つの active な
`home_cell` だけを持つ。
これは厳密な住所証明ではない。

MVP の contract は、GPS、IP geolocation、VPN detection、住所証明、
厳密な居住証明を Claim 条件として扱わない。
海のみのセルなど、居住地として自然でないセルの制限は
UI と verifier 側の入力検証で扱う。
この文書変更だけでは、新しい Move 実装、source 追加、schema 変更を要求しない。

## 4. Identity verification

本人確認結果は Nautilus が検証する。
contract は署名済みの identity verification result だけを受理する。

target signed result:

```text
IdentityVerificationResult {
  intent
  verifier_family
  verifier_version
  registry_id
  membership_id
  owner
  provider
  verified
  duplicate_key_hash
  evidence_hash
  issued_at_ms
  expires_at_ms
  terms_version
  signed_statement_hash
}
```

provider は MVP では KYC または World ID のみである。
`verified == true` の場合だけ、Membership SBT を本人確認済みにできる。

provider 内 duplicate key が別 SBT に使用済みなら reject する。
KYC と World ID をまたぐ完全な重複排除は MVP 外である。
その代わり、登録時と Claim 時に Sui wallet 署名済みの同意を要求する。

## 5. Claim eligibility

Disaster Claim は、次の条件をすべて検証する。

| 分類 | 条件 |
| --- | --- |
| Disaster | DisasterEvent が finalized 済み |
| SBT | Membership SBT が active |
| Time | `account_created_at_ms < disaster_cutoff_time` |
| Time | `home_cell_registered_at_ms < disaster_cutoff_time` |
| Area | `home_cell` が affected cells に含まれる |
| Identity | `identity_verified == true` |
| Identity | duplicate key がこの Membership SBT に紐づく |
| Recipient | 支払い先は Membership SBT owner の Sui address |
| Duplicate Claim | 同じ campaign / event で未 Claim |

`disaster_cutoff_time` は次の早い方である。

- earthquake occurred time
- Sonari candidate detected time

災害発生時刻は cutoff の source の一例である。
Claim timing の canonical term は `disaster_cutoff_time` である。
finalized time は cutoff に使わない。
発生後の駆け込み登録を防ぐためである。
災害後の居住セル変更は、その災害の Claim eligibility に使えない。
将来、より厳しくする場合は grace period を置き、
`last_changed_at_ms < disaster_cutoff_time - grace_period_ms` のように判定できる。
MVP では grace period の具体値をまだ決めない。

## 6. Payout policy

MVP の支給率は本人確認 provider で変えない。

```text
unverified
  -> no claim

KYC verified
  -> full claim

World ID verified
  -> full claim
```

支払額は disaster band と CampaignBudget で決める。

```text
Band 1: 50 USDC
Band 2: 150 USDC
Band 3: 300 USDC
```

Pool 残高、CampaignBudget、reserve constraints を超えて支払わない。
Operations Pool は Relief payout 原資に使わない。

## 7. Pool and donation

PR3 / MVP の Pool accounting は Circle Sui USDC 固定で扱う。
USDC decimals は 6 を前提にする。

Donation allocation:

```text
General Donation
  -> 100% Main Pool

Designated Donation
  -> 50% Designated Relief Pool
  -> 50% Main Pool

Operations Donation
  -> 100% Operations Pool
```

DonorPass と DonationRecord は寄付者の実績表示に使う。
Claim 権利や支払い保証は与えない。

## 8. Disaster claim composition

Disaster Claim は、DisasterEvent と Membership SBT を合成する。

```text
DisasterEvent affected_cells_root
  + AffectedCellLeaf proof
  + MembershipSBT.home_cell
  + MembershipSBT.identity_verified
  -> Claim decision
```

検証要件:

- Earthquake Oracle payload は署名済みである。
- `AffectedCellLeaf` は `affected_cells_root` に含まれる。
- leaf の h3 index は `MembershipSBT.home_cell` と一致する。
- leaf の band は event の minimum band 以上である。
- Membership SBT の作成時刻と居住セル登録時刻は cutoff より前である。
- Membership SBT は本人確認済みである。

Earthquake Oracle v1 の BCS field order、schema、golden vector は変更しない。

## 9. External API surface

user-facing API は `accessor` module に寄せる。
entry は薄く保ち、検証と状態遷移は package 内 helper に委譲する。

target API:

| API | 処理概要 |
| --- | --- |
| donation functions | USDC donation を Pool へ入れる |
| identity update | Nautilus 署名済み本人確認 result を反映する |
| disaster submit | Nautilus 署名済み災害 payload を保存する |
| disaster claim | Membership SBT と affected cell を検証して支払う |

別の受取先、銀行口座、外部送金先は MVP API に含めない。

## 10. Security requirements

| 区分 | 要件 |
| --- | --- |
| must | Pool 残高以上を支払わない |
| must | CampaignBudget 以上を支払わない |
| must | Main Pool reserve を侵さない |
| must | Operations Pool を Relief payout 原資にしない |
| must | Nautilus 署名済み result だけを信頼する |
| must | `identity_verified == true` を Claim に要求する |
| must | provider 内 duplicate key を検証する |
| must | Membership SBT owner にだけ支払う |
| must | 同じ campaign / event の二重 Claim を拒否する |
| must | paused 中の donation / claim / verifier update を拒否する |
| must not | raw personal data をオンチェーンに出す |
| must not | dapp、Relayer、Worker input を信用する |
| must not | DonorPass を Claim 権利として扱う |

## 11. Test requirements

| Test | 主要ケース |
| --- | --- |
| Membership | SBT issue、active check、duplicate owner reject |
| Identity | KYC verified update、World ID verified update |
| Identity | duplicate key reject、expired result reject |
| Identity | raw personal data が state に入らない |
| Claim | unverified SBT reject |
| Claim | account created after cutoff reject |
| Claim | home cell registered after cutoff reject |
| Claim | affected cell mismatch reject |
| Claim | valid KYC verified full Claim |
| Claim | valid World ID verified full Claim |
| Claim | duplicate key bound to another SBT reject |
| Claim | payout to SBT owner |
| Donation | USDC only、Pool split、zero amount reject |
| Admin | unauthorized reject、pause reject |

## 12. Current implementation gap

この spec は target MVP 仕様である。
現在の Move source は旧登録、別受取先、Residence / Student metadata、
支払額係数の前提を含む。

follow-up の実装 PR で、Move source と tests をこの spec に合わせる。
この docs PR では、BCS payload、schema、golden vector、Move source は変更しない。
