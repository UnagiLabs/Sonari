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
- TDD は、まず `contracts/spec.md` からロードマップ全体の feature-level test plan / acceptance matrix を作り、その後は PR / 機能単位で RED -> GREEN を回す。
- 実装 PR では、対象機能ごとに failing test を先に追加し、意図した未実装挙動で RED になることを確認してから production code を変更する。
- GREEN は最小実装で達成し、refactor した場合も同じ test を再実行して GREEN を維持する。
- 全ロードマップ分の executable test を一括で先に作らない。未実装 API や Move object shape を早すぎる段階で固定せず、長期間 RED の test を大量に維持しないためである。
- ただし、全体の test plan、acceptance matrix、PR ごとの検証観点は先に作成してよい。
- 実装 PR では schema、BCS field order、`AffectedCellLeaf` canonical order を必要なく変更しない。
- Pool、Program、Membership、Verifier Result、Claim、Admin の責務を分ける。
- User-facing callable API は `accessor.move` に集約する。PR3 の `accessor.move` は donation 実行と必要最小限の donation record read helper の薄い入口に留める。
- `admin.move` は `AdminCap` gated な admin-facing API を集約する。Pool 作成、DonorRegistry 作成、emergency pause 操作は `admin.move` に置き、実ロジックは責務を持つ各 module の private または `public(package)` helper に委譲する。
- `accessor.move` / `admin.move` 以外の責務 module は、検証、状態遷移、accounting、event emit などの実ロジックを private または `public(package)` helper に定義し、外部公開 API として分散させない。
- MembershipPass は全受取者必須にする。
- DonorPass は寄付者向け owned object / has key only の SBT とし、初回寄付時に自動発行する。
- DonorRegistry は donor address -> current DonorPass id の軽量 registry とし、重複発行防止と current DonorPass 確認に使う。
- DonationRecord は DonorPass に紐づく寄付履歴とし、2 回目以降の寄付も既存 DonorPass に追加する。
- DonorPass / DonationRecord は貢献証明と dapp 表示用であり、Claim / Payout 権利や支払い保証を与えない。
- DonorPass の migration / recovery API は MVP では実装せず、通常 transfer も拒否する。status や MembershipRecord 相当の構造は追加しない。
- MembershipPass は owned object / has key only / no `store` の SBT とし、MVP では wallet migration / wallet loss recovery API を実装しない。
- MembershipRegistry は current pass index、owner 重複登録防止、Claim current pass 検証、将来 recovery の拡張点として最小導入する。
- MembershipPass metadata は Nautilus 署名済み update のみ支払い判定に使う。
- raw email、phone、GPS 履歴、端末情報、住所、学籍番号などはオンチェーンに出さない。
- Verification Fee は Operations Pool へ入れ、支払い保証や Relief payout 原資として扱わない。
- Main Pool、Designated / Campaign Pool、Operations Pool を分離する。
- Disaster Claim は `DisasterEvent.affected_cells_root` と `MembershipPass.verified_residence_cell` の合成で判定する。
- Move は Relayer、Worker、dapp、D1、外部 API を信用しない。
- emergency pause を必ず入れる。

## 3. 共通 TDD cycle

PR 2 以降の実装は、以下の cycle を機能単位で繰り返す。

1. `contracts/spec.md` からロードマップ全体の feature-level test plan / acceptance matrix を作る。
2. 実装順に、今回の PR で扱う対象機能を小さく選ぶ。
3. その機能の failing test を先に追加し、RED を確認する。
4. RED が、意図した未実装挙動による失敗であることを確認する。fixture 不備、環境不備、無関係な既存失敗で RED にしない。
5. production code は、対象機能の RED が確認されるまで変更しない。
6. 最小実装で同じ test を GREEN にする。
7. 必要なら refactor し、同じ test と関連 check を再実行して GREEN を維持する。
8. 次の対象機能へ進む。

この cycle でいう test は、対象機能に応じて Move tests、Rust tests、TypeScript package tests、fixture / golden vector tests を選ぶ。すべてのロードマップ項目について executable test を一括作成するのではなく、全体計画だけを先に持ち、実装順に test を executable 化する。

各 PR の最初の test は、以下の PR 分割にある「最初に定義する test」から選ぶ。実装者はその場で test 観点を再設計せず、`contracts/spec.md` とこの文書の test-first matrix を正として RED -> GREEN を進める。API、Move object shape、entry 関数引数は、該当 PR の test を成立させる最小 surface に留める。

各実装 PR の完了条件には、PR 固有の完了条件に加えて以下を含める。

- PR 内の各対象機能について RED -> GREEN の証跡がある。
- RED は意図した未実装挙動による失敗であり、test 自体の typo や harness 不備ではない。
- Move tests と関連 package tests が通る。
- 実行していない重要な検証がある場合は、理由と残リスクを PR に明記する。

## 4. PR 分割

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

最初に定義する test:

- PR 1 は docs-only のため executable test は作らない。
- `contracts/spec.md` と `contracts/devflow.md` の acceptance matrix が、Pool split、MembershipPass、DonorPass、Claim / Payout、Disaster Oracle v1 の不変条件を覆うことをレビュー観点として固定する。
- schema、BCS field order、Move type、golden vector を変更していないことを diff で確認する。

実装順:

1. `contracts/spec.md` の中心概念、MVP 完成状態、Test 要件を正として読む。
2. `contracts/devflow.md` の PR 分割と Quality Gate を spec の要件順に合わせる。
3. docs-only 境界と既存 schema / golden vector 不変更を確認する。

完了条件:

- docs-only 差分である。
- existing Disaster Oracle v1 payload、schema、BCS field order、`AffectedCellLeaf` 仕様を変更していない。
- 既存の Pool split、MembershipPass、Claim / Payout、golden vector を変更していない。
- `contracts/spec.md` とこの devflow の test plan / acceptance matrix が矛盾していない。
- test plan が Pool split、MembershipPass、DonorPass、Claim / Payout、Disaster Oracle v1 の不変条件を覆っている。
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

最初に定義する test:

- `AdminCap` なしの `create_program` / `create_campaign` / `pause` が reject される。
- active な Program / Campaign の claim precheck が pass する。
- paused Program / Campaign の claim precheck が reject される。
- pause / unpause event が期待フィールドで emit される。

実装順:

1. `AdminCap` と admin-only assertion を実装する。
2. Program / Campaign object と status を作る。
3. global / target pause state を追加する。
4. Claim 側から使う active / paused precheck helper を追加する。
5. Program / Campaign / pause events を emit する。

完了条件:

- AdminCap なしの管理操作を拒否する。
- paused Program / Campaign の claim を拒否できる。
- Move tests が通る。

PR 2 の scaffold 範囲では、Campaign の claim window validation はまだ実装しない。
`claim_start_ms < claim_end_ms` の検証は Claim / Campaign 本実装 PR で追加し、その PR で invalid window の reject test も固定する。

Program / Campaign status 更新 entry も PR 2 では公開しない。
PR 2 では `#[test_only]` helper で status を切り替え、claim precheck が inactive / closed を拒否する contract-visible behavior だけを検証する。

### PR 3. Pool / Donation / DonorPass 基盤

対象:

- `contracts/sources/pools.move`
- `contracts/sources/donation.move`
- `contracts/tests/`

内容:

- Circle 公式 Sui USDC (`0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC`) 固定 accounting
- Main Pool
- Designated / Campaign Pool
- Operations Pool
- General Donation 100% Main Pool
- Designated Donation 50% Designated / Campaign Pool、50% Main Pool
- Operations Donation 100% Operations Pool
- 初回寄付時の DonorPass 自動発行
- DonorRegistry による duplicate donor pass 発行防止と current DonorPass 確認
- 2 回目以降の DonationRecord dynamic field 追加
- donor 集計更新: total donated、donation count、first / last donated timestamp、tier
- Pool / Donation events
- Donor events: `DonationRecorded`、`DonorPassIssued`、`DonorTierUpdated`

最初に定義する test:

- General Donation は 100% Main Pool に入る。
- Designated Donation は 50% Designated / Campaign Pool、50% Main Pool に split される。
- Operations Donation は 100% Operations Pool に入る。
- zero amount donation は reject される。
- 初回寄付で `DonorPass` が mint され、`DonorPassIssued` と `DonationRecorded` が emit される。
- 同じ donor の 2 回目の初回寄付は reject される。
- 2 回目以降の寄付は既存 `DonorPass` に `DonationRecord` を dynamic field として追加し、`DonationRecorded` を emit する。
- 2 回目以降の寄付で registry 上の current DonorPass id と渡された `DonorPass` id が一致しない場合は reject される。
- donor aggregate の `total_donated`、`donation_count`、first / last donated timestamp、tier が更新される。
- tier 変更時だけ `DonorTierUpdated` が emit される。
- paused donation は reject される。
- `DonorPass` / `DonationRecord` から Claim / Payout 権利を導けないことを test helper / accessor surface で固定する。
- `DonorPass` に status や MembershipRecord 相当の heavy record surface が存在しないことを固定する。

実装順:

1. Main / Designated / Campaign / Operations Pool の balance と累計を実装する。
2. donation amount validation と Pool split を実装する。
3. 初回寄付時の `DonorPass` issue と DonorRegistry duplicate guard を実装する。
4. 2 回目以降の current DonorPass 確認と `DonationRecord` dynamic field 追加を実装する。
5. donor aggregate と tier 更新を実装する。
6. donation / donor events を実装する。
7. paused donation reject と SBT transfer reject を接続する。

完了条件:

- Pool ごとに残高と累計を追跡できる。
- 初回寄付で DonorPass を発行し、2 回目以降の寄付を既存 DonorPass の履歴として記録できる。
- DonorRegistry が duplicate donor pass 発行防止と current DonorPass 確認を担う。
- DonorPass の集計情報と tier を更新できる。
- DonorPass は通常 transfer できない。
- DonorPass に status や MembershipRecord 相当の構造を追加しない。
- DonorPass / DonationRecord が Claim / Payout 権利を与えない。
- paused donation を拒否できる。
- Verification Fee 以外の Operations donation も扱える。
- repository-local の代替 coin を使わず、donation API と Pool balance は公式 Sui USDC type だけを受け取る。

### PR 4. MembershipPass SBT

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
- Verification Fee の Operations Pool 入金

PR4 の実装範囲:

- `MembershipPass` は `has key` のみを持つ owned object として発行する。`store` ability と通常 transfer 用 API は提供しない。
- user-facing callable API は `accessor::register_member_usdc` に集約し、global pause と `OperationsPool` target pause を検証する。
- USDC Verification Fee は Operations Pool の balance / total received にだけ入金し、Main Pool / Designated Pool / Campaign Pool には触れない。
- `MembershipPass` 本体は、owner、payout address、`pass_lineage_id`、status、issued timestamp、metadata update timestamp だけを保持する。
- `pass_lineage_id` は発行された pass の object id に固定し、duplicate claim prevention key は `(pass_lineage_id, campaign_id)` とする。
- `DonorPass` の `total_donated`、`donation_count`、tier、`DonationRecord` に相当する寄付集計・寄付履歴 surface は持たない。
- PR4 では `MembershipRegistry` や同一 wallet の重複発行防止は追加しない。Registry による重複発行防止と current pass index は PR6 で追補し、migration / recovery は MVP 外の follow-up とする。
- 後続の Claim 実装では、`membership::assert_claim_precheck` に未検証のユーザー引数を渡さず、通常は `ctx.sender()` などの信頼済み claimant を渡す。

最初に定義する test:

- `MembershipPass` を発行でき、owner、payout address、`pass_lineage_id`、active status を読める。
- `MembershipPass` は受取者向け Pass であり、寄付者向け `DonorPass` の aggregate / donation history を持たない。
- `register_member` の Verification Fee は Operations Pool に入り、Relief / Campaign Pool には入らない。
- Claim 対象者に `MembershipPass` 必須を要求する precheck ができる。
- `pass_lineage_id` を duplicate claim prevention key に使える。
- 通常 transfer は reject される。
- `MembershipPassIssued` が期待フィールドで emit される。

実装順:

1. `MembershipPass` object と status model を実装する。
2. `register_member` で Verification Fee を Operations Pool に入れる。
3. issue callable API と `MembershipPassIssued` event を実装する。
4. owner / payout address / lineage accessors を実装する。
5. Claim precheck 用 helper を実装する。
6. 通常 transfer reject を実装する。

完了条件:

- MembershipPass は受取者向け Pass であり、寄付者向け DonorPass と責務を混同しない。
- Claim 対象者は Pass 必須にできる。
- Pass lineage で二重 Claim 防止 key を作れる。
- 通常 transfer はできない。
- Verification Fee は Operations Pool のみへ入り、Main / Designated / Campaign Pool の原資と混同しない。

### PR 5. VerifierRegistry / signed metadata update

対象:

- `contracts/sources/metadata_verifier.move`
- `contracts/sources/membership.move`
- `contracts/tests/`

内容:

- Nautilus verifier public key registry
- verifier family / version は key registration 時点で `RESIDENCE` / `STUDENT` と `V1` のみに制限する
- MIGRATION family は追加しない
- ResidenceMetadataUpdate verification
- StudentMetadataUpdate verification
- freshness / expiry / replay prevention
- disabled verifier reject
- `sui::bcs::to_bytes(&message)` を Ed25519 署名対象として固定
- `pass_lineage_id × verifier_family` 単位の monotonic `update_id`
- metadata update は資金移動を伴わないため、MVP では MembershipPass 単体の lineage / owner binding / active status 検証を維持し、支払い安全性は Claim 側の Registry current pass 検証で担保する

最初に定義する test:

- registered verifier の valid ResidenceMetadataUpdate だけが `MembershipPass` の residence metadata を更新できる。
- valid StudentMetadataUpdate だけが student metadata を更新できる。
- invalid signature、expired update、replayed update、wrong verifier family、disabled key は reject される。
- signature bytes / public key bytes 長不正、unknown verifier family / version registration、wrong verifier version、wrong intent、future issued_at は reject される。
- paused verifier update / metadata update は reject される。
- `pass_lineage_id` / owner binding mismatch は reject される。
- raw email、phone、GPS 履歴、住所、学籍番号、学校メール raw value を保存する field がない。
- `PassMetadataUpdated`、`VerifierKeyAdded`、`VerifierKeyDisabled` が期待フィールドで emit される。

実装順:

1. `VerifierRegistry` と verifier key registration / disable を実装する。
2. verifier family / version / intent validation を実装する。
3. signature verification を実装する。
4. paused verifier update / metadata update reject を実装する。
5. freshness / expiry / replay prevention を実装する。
6. pass lineage / owner binding validation を実装する。
7. Residence / Student metadata write を `MembershipPass` に接続する。

完了条件:

- Pass metadata は署名済み update だけで更新できる。
- expired / replay / wrong family / disabled key を拒否する。
- Residence / Student metadata は別系列の `update_id` として replay prevention できる。
- 署名対象 struct の BCS bytes は fixture test で固定されている。
- raw personal data を保存しない。
- metadata update は global pause / VerifierRegistry target pause で拒否する。AdminCap gated な verifier key add / disable は pause 中も許可し、disable は emergency revoke として使える。二重 disable は拒否して disabled event の重複 emit を防ぐ。

### PR 6. MembershipRegistry minimal index

対象:

- `contracts/sources/membership.move`
- `contracts/sources/admin.move`
- `contracts/sources/accessor.move`
- `contracts/tests/`
- `contracts/spec.md`
- `contracts/devflow.md`

内容:

- `MembershipRegistry` shared object
- `MembershipRecord`
- owner address -> `pass_lineage_id` index
- AdminCap gated registry creation
- `accessor::register_member_usdc` に `MembershipRegistry` 引数を追加し、global pause / OperationsPool pause / Registry pause を維持して membership module の registry-aware helper に委譲する
- registration 時の record 作成
- duplicate owner registration reject
- Registry accessor
- Claim precheck 用 helper

最初に定義する test:

- `MembershipRegistry` を AdminCap gated API で作成できる。
- registry-aware `register_member_usdc` で MembershipPass が発行され、Registry に record が作成される。
- record の `pass_lineage_id`、`current_pass_id`、`current_owner`、`current_payout_address`、`status` が Pass と一致する。
- `owner_index` から owner -> `pass_lineage_id` を引ける。
- 同じ owner の 2 回目 registration は reject され、別 owner は登録できる。
- Registry record が存在しない、wrong pass id、wrong owner、payout address mismatch、inactive registry status は current pass precheck で reject される。
- active/current pass precheck は通る。
- global pause / OperationsPool pause / MembershipRegistry pause 中の registration は reject される。
- PR5 の Residence / Student metadata update tests は引き続き通る。
- MVP API / Event / PR6 implementation scope に MIGRATION family、MigrationMessage、PassMigrated、wallet migration API が存在しない。

実装順:

1. `MembershipRegistry` / `MembershipRecord` と AdminCap gated creation を実装する。
2. owner duplicate guard と owner index accessor を実装する。
3. `register_member_usdc` を registry-aware にし、既存 pause check と Verification Fee 入金を維持する。
4. registration 時に MembershipPass と Registry record を同一 transaction で作成する。
5. Claim precheck 用の Registry / Pass 整合性 helper を実装する。
6. migration / recovery API surface がないことを test と diff で確認する。

完了条件:

- MembershipRegistry が current pass index と owner 重複発行防止を担う。
- Claim precheck が Registry record と MembershipPass の id / owner / payout address / status 整合性を検証できる。
- MVP では owner index、current pass、current owner、current payout address、Registry status の更新・削除 API を提供しない。
- migration 関連語が docs に出る場合は Future / Non-MVP / Follow-up セクションに限定され、MVP API / Event / Test / PR6 scope には残らない。

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

最初に定義する test:

- eligibility tier ごとの base amount を計算できる。
- MVP Disaster Relief の table-driven test で Band 1 / 2 / 3 が 50 / 150 / 300 USD 相当になる。
- membership age multiplier、confidence multiplier、risk multiplier を適用できる。
- membership age multiplier は登録 30 日未満 = 0、30〜90 日 = 0.5、90 日以上 = 1.0 になる。
- risk multiplier は Low = 1.0、Medium = 0.5、High = 0 になる。
- high risk は payout 0 または reject になる。
- user max amount と policy max amount を超えない。
- CampaignBudget remaining budget を超えない。
- `future_reserve_floor = main_pool_total * 50%`、`liquid_reserve_target = main_pool_total * 70%`、`main_backstop_budget = min(liquid_reserve_target * 20%, main_pool_spendable)`、`designated_budget = matching_designated_pool_balance * 80%` を table-driven test で固定する。
- designated budget を優先し、不足分だけ Main Pool backstop を使う。
- Main Pool future reserve floor を侵さない。
- stale metadata payout は reject または 0 になる。

実装順:

1. `PayoutPolicy` の tier amount と multiplier 計算を実装する。
2. user / policy max cap を実装する。
3. `CampaignBudget` の designated budget、main backstop budget、claimed、remaining を実装する。
4. Main Pool reserve rule を `pools` に実装する。
5. payout quotation helper を作り、Claim PR から再利用できるようにする。

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
- MembershipRegistry + MembershipPass current pass validation
- required metadata validation
- `EligibilityResult` validation
- duplicate claim prevention by `pass_lineage_id + campaign_id`
- payout execution
- ClaimReceipt

最初に定義する test:

- valid generic claim は Program / Campaign、MembershipPass、metadata、EligibilityResult、budget、Pool を検証して payout し、`ClaimReceipt` を作る。
- inactive / paused Program or Campaign は reject される。
- `MembershipPass` がない、inactive、suspended、revoked、migrated の Claim は reject される。
- Registry record がない、inactive、wrong pass id、wrong owner、payout address mismatch の Claim は reject される。
- claimant が Registry current owner でも Pass payout address でもない Claim は reject される。
- required metadata がない、expired、wrong family の Claim は reject される。
- `EligibilityResult` の program / campaign / pass lineage mismatch は reject される。
- `pass_lineage_id + campaign_id` の duplicate claim は reject される。
- Verification Fee / Operations Pool は Relief / Campaign payout 原資に使えない。
- Pool 残高、CampaignBudget、PayoutPolicy cap を超える Claim は reject または cap される。

実装順:

1. Program / Campaign active validation を接続する。
2. MembershipRegistry + MembershipPass current pass validation と required metadata validation を接続する。
3. claimant と Registry current owner / Pass payout address の一致を検証する。
4. `EligibilityResult` validation を実装する。
5. duplicate claim prevention key を実装する。
6. Verification Fee / Operations Pool を payout 原資から除外する。
7. PayoutPolicy / CampaignBudget / Pool debit を接続する。
8. `ClaimReceipt` と `ClaimPaid` / `ClaimReceiptCreated` event を実装する。

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

最初に定義する test:

- `schemas/examples/unsigned_payload_v1.json` と `expected_hashes.json` 由来の unsigned BCS payload bytes を v1 field order で decode できる。
- finalized payload は `DisasterEvent` を作成し、event uid、revision、hazard type、`affected_cells_root`、`affected_cells_data_hash`、min claim band を保存する。
- pending / rejected / ignored_small status は object 化しない。
- invalid intent、unsupported `oracle_version`、expired freshness、empty finalized URI、`affected_cell_count = 0`、`min_claim_band != 1` は reject される。
- duplicate event uid / revision は reject される。
- BCS field order、enum 値、schema、golden vector を変更しない。

実装順:

1. `payload_v1` decoder を既存 schema field order に合わせて実装する。
2. finalized payload constraints を実装する。
3. signature / intent / freshness / revision validation を実装する。
4. `DisasterEvent` storage と `DisasterEventCreated` event を実装する。
5. duplicate event guard を実装する。

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

最初に定義する test:

- `schemas/examples/affected_cells.json` の sample leaf BCS hash が `schemas/examples/expected_hashes.json` と一致する。
- `schemas/examples/sample_proof.json` の Merkle proof が expected root に一致する。
- wrong root、wrong event uid、wrong revision、wrong h3 index、band below min claim band は reject される。
- `AffectedCellLeaf` canonical order が `schemas/affected_cell_leaf.md` と一致する。

実装順:

1. `AffectedCellLeaf` BCS decode を schema 順に実装する。
2. leaf hash `SHA3-256(0x00 || BCS(AffectedCellLeaf))` を実装する。
3. Merkle proof verification を実装する。
4. root comparison と event uid / revision / h3 index / band validation を実装する。
5. fixture proof を Move test で検証する。

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

最初に定義する test:

- valid disaster claim は `DisasterEvent.affected_cells_root`、`AffectedCellLeaf` proof、`MembershipPass.verified_residence_cell` を合成して payout できる。
- `leaf.h3_index != MembershipPass.verified_residence_cell` は reject される。
- Pass residence metadata がない、期限切れ、low confidence、high risk、wrong cell は reject される。
- Registry current pass と MembershipPass の id / owner / payout address mismatch は reject される。
- Pass residence metadata の `verified_at` が disaster occurred_at / claim window policy を満たさない Claim は reject される。
- `leaf.cell_band < DisasterEvent.min_claim_band` は reject される。
- cell band から eligibility tier を決め、PayoutPolicy / CampaignBudget を適用する。
- Earthquake Pool を優先し、不足分だけ Main Pool backstop を使う。
- `pass_lineage_id + campaign_id/event_uid` の duplicate claim は reject される。

実装順:

1. DisasterEvent と generic Campaign / Claim の接続 helper を実装する。
2. AffectedCell proof validation を Claim に接続する。
3. Pass residence metadata match と freshness / verified_at / confidence / risk validation を実装する。
4. cell band -> eligibility tier mapping を実装する。
5. generic payout path を通して Disaster Claim を支払う。
6. event-specific duplicate key を実装する。

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

最初に定義する test:

- Student Aid Program / Campaign fixture で valid student metadata を持つ `MembershipPass` が Claim できる。
- student metadata がない、expired、wrong family、low confidence、high risk の Claim は reject される。
- Student eligibility tier と Campaign Pool payout が generic Claim 基盤で処理される。
- raw student id、school email、在学証明書画像、氏名、住所を保存する field がない。
- Disaster object なしでも Program / Campaign / Claim / Payout 基盤が使える。

実装順:

1. Student Aid Program / Campaign fixture を作る。
2. Student metadata required condition を generic Program / Claim に接続する。
3. student eligibility tier を PayoutPolicy に接続する。
4. Campaign Pool payout を generic Claim 経由で実行する。
5. privacy field absence を test で固定する。

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

最初に定義する test:

- dapp read fixture / helper から Program、Campaign、Pool、MembershipPass、DonorPass、DonationRecord、ClaimReceipt を読める。
- DonorPass aggregate、donation history、donor tier、donor events を dapp 表示用に取得できる。
- Claim history、paid amount、paid_from、claimed_at を取得できる。
- read model に raw personal data が含まれない。
- event field 名と object accessor が docs と一致する。

実装順:

1. dapp が読む event / object field を整理する。
2. object accessor helper または integration docs を追加する。
3. DonorPass / DonationRecord / ClaimReceipt の read model fixture を追加する。
4. raw personal data absence と field naming を確認する。

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

最初に定義する test:

- dry-run deployment config が initial Program / Pool / Policy / verifier key の必須値不足を reject する。
- dry-run deployment config が secret-like value の repo 混入を reject する。
- initial Program / Pool / Policy parameter が `contracts/spec.md` の Pool split、Operations separation、reserve rule と一致する。
- verifier key registration docs が required family / version / disabled flag を含む。

実装順:

1. deploy parameter schema / validation を定義する。
2. dry-run script または docs command を作る。
3. AdminCap 保管手順を docs 化する。
4. initial Program / Pool / Policy setup を docs 化する。
5. verifier key registration を docs 化する。

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

最初に定義する test:

- smoke sequence が donate -> DonorPass issued -> register pass -> residence metadata update -> disaster payload submit -> campaign budget open -> claim -> receipt / dashboard read を通る。
- DonorPass issued / donation history / total donated / donor tier が確認できる。
- MembershipPass status と metadata freshness が確認できる。
- ClaimReceipt と Pool / budget 残高変化が確認できる。
- smoke output に secret や raw personal data が含まれない。

実装順:

1. reusable smoke fixture を作る。
2. localnet / testnet command sequence を docs または script にする。
3. expected output と failure triage を記録する。
4. dashboard / read model confirmation を smoke に接続する。

完了条件:

- mainnet または testnet で最小 E2E を説明できる。
- `pnpm check`、Move tests、関連 smoke が通る。

## 5. 後回しにするもの

- 実 SUI staking / Scallop strategy 入金
- 複数 verifier quorum
- 本番 KYC / 学校 API / 住所 API 接続
- DonorPass migration / recovery API
- MembershipPass wallet migration / wallet loss recovery API
- MIGRATION verifier family / MigrationMessage / PassMigrated event
- full pro-rata payout
- DAO governance
- manual review workflow
- 法定寄付領収書

## 6. Quality Gate

各実装 PR で最低限確認する。

- `pnpm check`
- `pnpm typecheck`
- `pnpm test`
- `cd contracts && sui move build --lint`
- `cd contracts && sui move test`
- `git diff --check`

docs-only PR では以下を確認する。

- Markdown 見出し階層
- Mermaid fence の基本構文
- docs-only 差分であること
- `contracts/spec.md` と devflow の test plan / acceptance matrix が矛盾しないこと
- test plan が Pool split、MembershipPass、DonorPass、Claim / Payout、Disaster Oracle v1 不変条件を覆うこと
- `DisasterEvent` が唯一の Claim 基盤に見える表現が残っていないこと
- DonorPass が Claim / Payout 権利や支払い保証に見える表現が残っていないこと
- MembershipPass が受取者向け、DonorPass が寄付者向けとして分離されていること
- General 100% Main、Designated 50/50、Operations 100% Operations の既存 donation split が維持されていること
- raw 個人情報をオンチェーンに出す表現が残っていないこと
- 保険料、掛け金、支払い保証に見える表現が残っていないこと
- migration 関連語がある場合は Future / Non-MVP / Follow-up に限定され、MVP API / Event / Test / PR6 scope に残っていないこと

実装 PR では以下も確認する。

- 該当 PR の「最初に定義する test」から executable test を選び、test 観点をその場で再設計していないこと
- 対象機能ごとに failing test を先に追加していること
- RED が意図した未実装挙動による失敗であること
- 最小実装後に同じ test が GREEN になっていること
- `git diff --check`、`cd contracts && sui move build --lint`、`cd contracts && sui move test`、関連 `pnpm` checks を実行していること
- 実行していない test がある場合は、理由と後続 PR を明記していること
- pause は donation / claim / verifier update すべてに適用されること
- Verification Fee / Operations Pool を Relief / Campaign payout 原資にしないこと
- 初回寄付で `DonorPassIssued` と `DonationRecorded` が emit されること
- すべての寄付で `DonationRecorded` が emit されること
- tier 変更時のみ `DonorTierUpdated` が emit されること
- DonorRegistry が duplicate donor pass 発行防止と current DonorPass 確認を行うこと
- DonorPass の通常 transfer を拒否すること
- DonorPass に status や MembershipRecord 相当の構造を追加していないこと
- DonationRecord に raw 個人情報を保存しないこと
