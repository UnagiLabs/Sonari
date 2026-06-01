# Sonari Contracts Smoke Plan

この smoke plan は target MVP 仕様の確認手順である。
現在の Move source が未対応の項目は、follow-up 実装 PR で有効にする。

## 1. Setup

- package publish 済みである。
- Main Pool、Designated Pool、Operations Pool が存在する。
- Disaster Relief Program と Earthquake Campaign が存在する。
- Nautilus verifier key が登録されている。
- KYC / World ID identity verifier key が登録されている。
- 許可居住セル Merkle root が登録されている。

## 2. Happy path

1. Sponsor が Earthquake Pool へ USDC を寄付する。
2. Nautilus が earthquake payload を finalized する。
3. DisasterEvent が on-chain に作成される。
4. User が災害前に Membership SBT を作成済みである。
5. User が許可居住セル proof 付きで home cell を登録済みである。
6. Nautilus が KYC または World ID result を署名する。
7. Membership SBT に `identity_verified == true` が反映される。
8. IdentityRegistry が duplicate key とこの SBT の紐づきを持つ。
9. User が affected cell proof を付けて Claim する。
10. Move が cutoff、affected cell、本人確認を検証する。
11. Earthquake Pool から SBT owner へ支払う。
12. ClaimReceipt が作成される。

KYC / World ID はどちらも満額 route である。
本人確認 provider による支給率差は作らない。

## 3. Reject cases

- DisasterEvent が finalized 済みでなければ reject する。
- Membership SBT が active でなければ reject する。
- `account_created_at_ms` が cutoff 以後なら reject する。
- `home_cell_registered_at_ms` が cutoff 以後なら reject する。
- 許可居住セル proof が不正なら登録を reject する。
- 許可居住セル proof が不正なら居住セル変更を reject する。
- 他人の current pass は居住セル変更で reject する。
- home cell が affected cells に含まれなければ reject する。
- `identity_verified == true` でなければ reject する。
- provider 内 duplicate key が別 SBT に使用済みなら reject する。
- Claim 時に duplicate key がこの SBT に紐づかなければ reject する。
- 同じ campaign / event の二重 Claim は reject する。
- paused 中の Claim は reject する。

## 4. Privacy checks

次の値は on-chain state や event に出さない。

- raw KYC data
- World ID proof detail
- credential detail
- document image
- phone
- GPS history
- detailed address

保存してよい値は、hash、provider、verified flag、issued / expiry、
terms version、signed statement hash などの最小情報だけである。
