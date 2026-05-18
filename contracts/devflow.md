# Sonari Sui Contracts 開発フロー

## 1. 目的

この文書は、Sonari Sui Contracts を「Nautilus で受取対象を検証できる汎用寄付プラットフォーム」として mainnet に載せるための PR 順序を定義する。

実装の順序は、災害専用 object から始めるのではなく、次の依存関係を優先する。

```text
Program / Pool / Donation / DonorPass / Membership
  -> generic Nautilus verifier result
  -> generic claim / payout
  -> disaster verifier 接続
  -> residence / student verifier 拡張
```

Disaster Relief は最初の Program であり、`DisasterEvent` はその Program 固有 object である。contracts の中心は `Program / Campaign`、`Pool`、`MembershipPass`、`DonorPass`、`DonationRecord`、`Nautilus Verifier Result`、`EligibilityResult`、`Claim / Payout` に置く。

## 2. 開発方針

- mainnet で実際に動く完成品を目標にする。
- PR 1 は docs-only とし、PR 2 以降を実装 follow-up とする。
- 実装 PR では schema、BCS field order、`AffectedCellLeaf` canonical order を必要なく変更しない。
- Pool、Program、Membership、Verifier Result、Claim、Admin の責務を分ける。
- MembershipPass は全受取者必須にする。
- DonorPass は寄付者向け準 SBT とし、初回寄付時に自動発行する。
- DonationRecord は DonorPass に紐づく寄付履歴とし、2 回目以降の寄付も既存 DonorPass に追加する。
- DonorPass / DonationRecord は貢献証明と dapp 表示用であり、Claim / Payout 権利や支払い保証を与えない。
- DonorPass の wallet migration は follow-up とし、MVP では通常 transfer を拒否する。
- MembershipPass は準 SBT とし、Nautilus 署名付き migration result がある場合だけ移行を許可する。
- MembershipPass metadata は Nautilus 署名済み update のみ支払い判定に使う。
- raw email、phone、GPS 履歴、端末情報、住所、学籍番号などはオンチェーンに出さない。
- Verification Fee は Operations Pool へ入れ、支払い保証や Relief payout 原資として扱わない。
- Main Pool、Designated / Campaign Pool、Operations Pool を分離する。
- Disaster Claim は `DisasterEvent.affected_cells_root` と `MembershipPass.verified_residence_cell` の合成で判定する。
- Move は Relayer、Worker、dapp、D1、外部 API を信用しない。
- emergency pause を必ず入れる。

## 3. PR 分割

### PR 1. docs: contractsを汎用Program基盤へ更新

対象:

- `contracts/spec.md`
- `contracts/devflow.md`
- `docs/business_logic.md`
- `docs/tech_stack.md`
- `docs/nautilus_disaster_oracle/spec.md`
- `docs/nautilus_disaster_oracle/devflow.md`
- `docs/nautilus_membership_verifier/spec.md`
- `docs/nautilus_membership_verifier/devflow.md`

内容:

- Sonari を汎用寄付プラットフォームとして再定義する。
- `Program / Campaign`、`Pool`、`MembershipPass`、`DonorPass`、`DonationRecord`、`NautilusVerifierResult`、`EligibilityResult`、`Claim / Payout` を docs 上の中心概念にする。
- `DisasterEvent` は Disaster Relief Program 固有 object として位置づける。
- DonorPass、DonationRecord、初回寄付時の自動発行、寄付履歴、donor tier、donor events を定義する。
- Membership Pass、Residence / Student metadata、Web MVP residence confidence scoring、Student Aid model を定義する。
- Disaster Oracle は災害対象セル root 作成に集中し、個人 residence 判定は membership verifier に分離する。

完了条件:

- docs-only 差分である。
- existing Disaster Oracle v1 payload、schema、BCS field order、`AffectedCellLeaf` 仕様を変更していない。
- 既存の Pool split、MembershipPass、Claim / Payout、golden vector を変更していない。
- 汎用 Program 基盤から disaster / student へ自然に拡張できる。

### PR 2. Program / Admin / Pause scaffold

対象:

- `contracts/sources/admin.move`
- `contracts/sources/program.move`
- `contracts/tests/`

内容:

- `AdminCap`
- global / target pause
- `Program`
- `Campaign`
- Program / Campaign status
- Program / Campaign events

完了条件:

- AdminCap なしの管理操作を拒否する。
- paused Program / Campaign の claim を拒否できる。
- Move tests が通る。

### PR 3. Pool / Donation / DonorPass 基盤

対象:

- `contracts/sources/pools.move`
- `contracts/sources/donation.move`
- `contracts/tests/`

内容:

- Main Pool
- Designated / Campaign Pool
- Operations Pool
- General Donation 100% Main Pool
- Designated Donation 50% Designated / Campaign Pool、50% Main Pool
- Operations Donation 100% Operations Pool
- 初回寄付時の DonorPass 自動発行
- 2 回目以降の DonationRecord dynamic field 追加
- donor 集計更新: total donated、donation count、first / last donated timestamp、tier
- Pool / Donation events
- Donor events: `DonationRecorded`、`DonorPassIssued`、`DonorTierUpdated`

完了条件:

- Pool ごとに残高と累計を追跡できる。
- 初回寄付で DonorPass を発行し、2 回目以降の寄付を既存 DonorPass の履歴として記録できる。
- DonorPass の集計情報と tier を更新できる。
- DonorPass は通常 transfer できない。
- DonorPass / DonationRecord が Claim / Payout 権利を与えない。
- paused donation を拒否できる。
- Verification Fee 以外の Operations donation も扱える。

### PR 4. MembershipPass 準 SBT

対象:

- `contracts/sources/membership.move`
- `contracts/tests/`

内容:

- `MembershipPass`
- `pass_lineage_id`
- owner / payout address
- status: active / suspended / revoked / migrated
- direct transfer rejection
- Pass issue event

完了条件:

- MembershipPass は受取者向け Pass であり、寄付者向け DonorPass と責務を混同しない。
- Claim 対象者は Pass 必須にできる。
- Pass lineage で二重 Claim 防止 key を作れる。
- 通常 transfer はできない。

### PR 5. VerifierRegistry / signed metadata update

対象:

- `contracts/sources/metadata_verifier.move`
- `contracts/sources/membership.move`
- `contracts/tests/`

内容:

- Nautilus verifier public key registry
- verifier family / version
- ResidenceMetadataUpdate verification
- StudentMetadataUpdate verification
- freshness / expiry / replay prevention
- disabled verifier reject

完了条件:

- Pass metadata は署名済み update だけで更新できる。
- expired / replay / wrong family / disabled key を拒否する。
- raw personal data を保存しない。

### PR 6. Pass migration

対象:

- `contracts/sources/membership.move`
- `contracts/tests/`

内容:

- Nautilus 署名付き migration result
- old owner / new owner binding
- `pass_lineage_id` 維持
- migrated status
- migration event

完了条件:

- wallet 紛失時の移行を準 SBT 方針の範囲で扱える。
- migration result なしの owner 変更を拒否する。
- 二重 migration を拒否する。

### PR 7. Generic PayoutPolicy / CampaignBudget

対象:

- `contracts/sources/payout_policy.move`
- `contracts/sources/pools.move`
- `contracts/tests/`

内容:

- eligibility tier base amount
- membership multiplier
- confidence multiplier
- risk multiplier
- user / policy max cap
- CampaignBudget
- designated budget + main backstop budget
- future reserve protection

完了条件:

- Program / Campaign Claim が budget と reserve を超えない。
- Disaster EventBudget 相当の budget を CampaignBudget として扱える。
- high risk / stale metadata payout を拒否または 0 にできる。

### PR 8. Generic Claim / Receipt

対象:

- `contracts/sources/claim.move`
- `contracts/tests/`

内容:

- Program / Campaign active validation
- MembershipPass validation
- required metadata validation
- `EligibilityResult` validation
- duplicate claim prevention by `pass_lineage_id + campaign_id`
- payout execution
- ClaimReceipt

完了条件:

- disaster 以外の Program でも Claim できる形になる。
- Pool 残高、CampaignBudget、PayoutPolicy cap を超えない。
- duplicate claim を拒否する。

### PR 9. Disaster Oracle payload v1 接続

対象:

- `contracts/sources/payload_v1.move`
- `contracts/sources/disaster_event.move`
- `contracts/tests/`

内容:

- 既存 Disaster Oracle v1 BCS payload decode
- signature / intent / freshness / revision validation
- `DisasterEvent` 作成
- `affected_cells_root` 保存
- duplicate event reject

完了条件:

- 既存 fixture 由来 payload を受理できる。
- pending / rejected / ignored_small は object 化しない。
- BCS field order と schema を変更しない。

### PR 10. AffectedCell proof

対象:

- `contracts/sources/affected_cell.move`
- `contracts/tests/`

内容:

- `AffectedCellLeaf` BCS decode
- leaf hash
- Merkle proof verification
- root comparison
- event uid / revision / h3 index / band validation

完了条件:

- Disaster Oracle fixture proof を Move で検証できる。
- `AffectedCellLeaf` canonical order を既存 schema と一致させる。

### PR 11. Disaster Claim composition

対象:

- `contracts/sources/claim.move`
- `contracts/sources/disaster_event.move`
- `contracts/tests/`

内容:

- Disaster Relief Program / Campaign と `DisasterEvent` 接続
- `affected_cells_root` proof
- `MembershipPass.verified_residence_cell` との一致
- cell band -> eligibility tier
- Earthquake Pool priority + Main Pool backstop

完了条件:

- `DisasterEvent.affected_cells_root + Pass.verified_residence_cell` で Claim 判定できる。
- Pass residence metadata がない、期限切れ、low confidence、wrong cell の Claim を拒否する。
- Pool / budget cap を超えない。

### PR 12. Student Aid Program demo

対象:

- `contracts/sources/program.move`
- `contracts/sources/claim.move`
- `contracts/tests/`

内容:

- Student Aid Program / Campaign fixture
- Student metadata required condition
- student eligibility tier
- Campaign Pool payout

完了条件:

- Disaster 以外の Program で汎用基盤が使えることを test で示す。
- 学籍番号や学校メール raw value を保存しない。

### PR 13. dapp read model / events alignment

対象:

- contracts events
- dapp integration docs or read helpers

内容:

- Dashboard に必要な event / object field を整理する。
- Program / Campaign / Pool / MembershipPass / DonorPass / DonationRecord / ClaimReceipt を dapp が読める形にする。
- DonorPass、donation history、total donated、donor tier、donor events を dapp read model に含める。

完了条件:

- dapp から Donation、MembershipPass、DonorPass、donation history、Program、Campaign、Claim history を表示できる。

### PR 14. Mainnet deployment scripts

対象:

- deploy scripts
- admin setup docs
- verifier key registration docs

内容:

- package publish
- AdminCap 保管手順
- initial Program / Pool / Policy
- Nautilus verifier key 登録

完了条件:

- mainnet deployment 手順が再現可能。
- secret を repo に置かない。

### PR 15. End-to-end smoke

対象:

- scripts / docs
- optional dapp smoke

内容:

- donate
- DonorPass issued / donation history 表示確認
- register pass
- submit residence metadata update
- submit disaster payload
- open campaign budget
- claim
- receipt / dashboard confirmation

完了条件:

- mainnet または testnet で最小 E2E を説明できる。
- `pnpm check`、Move tests、関連 smoke が通る。

## 4. 後回しにするもの

- 実 SUI staking / Scallop strategy 入金
- 複数 verifier quorum
- 本番 KYC / 学校 API / 住所 API 接続
- full pro-rata payout
- DAO governance
- manual review workflow
- 法定寄付領収書

## 5. Quality Gate

各実装 PR で最低限確認する。

- `pnpm check`
- `pnpm typecheck`
- `pnpm test`
- Move build / test
- `git diff --check`

docs-only PR では以下を確認する。

- Markdown 見出し階層
- Mermaid fence の基本構文
- docs-only 差分であること
- `DisasterEvent` が唯一の Claim 基盤に見える表現が残っていないこと
- DonorPass が Claim / Payout 権利や支払い保証に見える表現が残っていないこと
- MembershipPass が受取者向け、DonorPass が寄付者向けとして分離されていること
- General 100% Main、Designated 50/50、Operations 100% Operations の既存 donation split が維持されていること
- raw 個人情報をオンチェーンに出す表現が残っていないこと
- 保険料、掛け金、支払い保証に見える表現が残っていないこと

実装 PR では以下も確認する。

- 初回寄付で `DonorPassIssued` と `DonationRecorded` が emit されること
- すべての寄付で `DonationRecorded` が emit されること
- tier 変更時のみ `DonorTierUpdated` が emit されること
- DonorPass の通常 transfer を拒否すること
- DonationRecord に raw 個人情報を保存しないこと
