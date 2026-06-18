# Contract Republish Runbook

この runbook は、ABI 破壊的な contract 変更後に `sui client upgrade` ではなく新 package として publish し直す場合の手順をまとめる。issue #361 の前提を反映し、手順、更新対象、失敗しやすい箇所、完了条件を 1 か所に集約する。

## 目的と不変条件

新 package publish では package id と genesis object ID がすべて新しくなる。`contracts/Published.toml`、GitHub Variables / Secrets、AWS stack parameter、dapp env、World ID action のいずれかが古い ID / action を指したままだと、relayer、TEE registration、dapp、smoke が別々の失敗として壊れる。

守る不変条件:

- compatible upgrade ではなく new package publish として扱う。`contracts/Published.toml` の `published-at` と `original-id` は新 package id に揃える。
- `contracts/Published.toml` は package id の単一情報源である。dev deploy workflow と dapp deploy はこの値から package id を導出する。
- genesis object ID と post-publish object ID は、対応表どおり GitHub Variables / Secrets へ張り替える。特に `VerifierRegistry`、`DisasterRegistry`、`AllowedResidenceCellRegistry` は混在させない。
- `DisasterRegistry` と `AllowedResidenceCellRegistry` は publish 後に admin 関数で作成する。`AllowedResidenceCellRegistry` は作成時に production 用の real residence root を入れ、後から test / golden root を update して合わせない。
- World ID action は Portal と repo-level GitHub Variable `SONARI_WORLD_ID_ACTION` を同じ `sonari_membership_register_v<N>` に揃える。ずれると proof 検証が通らない。
- verifier / relayer / contract の責務境界を変えない。Worker / watcher は候補検出と queue / state 管理、TEE / verifier は外部 source 再取得・検証・正規化・Merkle root・BCS payload・署名、Relayer は finalized payload 配送、Move contract は contract 側で検証可能な署名済み payload と registry state だけを信頼する。
- mainnet `AdminCap` の秘密鍵を CI、AWS Runner、EC2、Lambda、SSM、AWS Secrets Manager に置かない。dev/testnet の PCR 自動再登録だけが `SONARI_DEV_ADMIN_PRIVATE_KEY` を使う明示的な例外である。

関連資料:

- [PCR config runbook](../../../infra/aws/sonari-verifier-runner/docs/pcr-config.md)
- [Deploy runbook](../../../infra/aws/sonari-verifier-runner/docs/deploy.md)
- [Smoke runbook](../../../infra/aws/sonari-verifier-runner/docs/smoke-runbook.md)
- [republish bootstrap script](../../../scripts/republish_contracts_bootstrap.ts)
- [Published.toml](../../../contracts/Published.toml)

`scripts/republish_contracts_bootstrap.ts` が存在しない checkout では、bootstrap automation の実装または復元を先に行う。手作業で転記する場合も、この runbook の対応表と完了条件を gate として使う。

## 実行順序

### 1. publish 前確認

`main` に対象 contract 変更が入っていること、`contracts/Published.toml` の現 package id、resolver で導出される現 object ID、World ID action の現値を控える。`scripts/republish_contracts_bootstrap.ts` を使う場合は、まず dry-run で publish、`GenesisObjectCreated` 解析、`Published.toml` 書換え、cross-check を確認する。

確認対象:

- `contracts/Published.toml` の `[published.testnet]` `published-at` / `original-id`
- `.github/workflows/aws-sonari-verifier-runner-dev-deploy.yml` の required env と `WORLD_ID_ACTION` validation
- `.github/workflows/dapp-deploy.yml` の `NEXT_PUBLIC_WORLD_ID_ACTION` validation
- `infra/aws/sonari-verifier-runner/docs/deploy.md` と `infra/aws/sonari-verifier-runner/docs/pcr-config.md` の最新手順

GitHub Actions、Sui publish、AWS deploy、World ID Portal 変更は、この確認だけでは実行しない。

### 2. admin wallet 確認

dev/testnet publish は project-local admin wallet を使う。Sui / Walrus 関連の local config は repo 直下の `.local/sonari-dev/` 配下に置く。admin wallet は `.local/sonari-dev/sui_wallets/admin/` を使い、SourceArchiver hot wallet や relayer wallet と混ぜない。

確認事項:

- publish 送信者が新 `AdminCap` と `Publisher` を受け取る wallet である。
- gas が足りる。
- mainnet `AdminCap` の秘密鍵を GitHub、AWS、ログ、script argument に出さない。
- dev deploy workflow の PCR 自動再登録に使う secret は `SONARI_DEV_ADMIN_PRIVATE_KEY` で、environment `aws-sonari-verifier-runner-dev` scope の dev/testnet 専用鍵である。

### 3. bootstrap script 実行

`scripts/republish_contracts_bootstrap.ts` は次を 1 コマンドで行う automation entry point として扱う。

1. `sui client publish` を admin wallet で実行する。
2. publish transaction の `contracts::admin::GenesisObjectCreated` を解析し、kind ごとの object ID を回収する。
3. `admin::create_disaster_registry` を呼び、`DisasterRegistry` を作成する。
4. `admin::create_allowed_residence_cell_registry` を real residence root で呼び、`AllowedResidenceCellRegistry` を作成する。
5. `contracts/Published.toml` の `published-at` / `original-id` を新 package id へ更新する。
6. 対応表どおり GitHub Variables / Secrets を更新する。

real residence root は、issue #361 の前提では次の値を使う。

```text
root = 0x339601f3f8fc103fbbf526b39537235d7f6ad033a236f8c59f60498240a11ecc
source_hash = 0x4e47e035541b6915f9afb2d87237e1d8562063a1946e5ec91618bd1b260f2108
geo_resolution = 7
allowlist_version = 1
```

`data/residence_cells/allowed_residence_cells_manifest.v1.res7.json` がある checkout では、`artifact.merkle_root` と `artifact.sha256` が上記と一致することを確認する。`source.sha256` は upstream source の hash であり、registry の `source_hash` ではない。

### 4. `Published.toml` 更新

publish 後、`contracts/Published.toml` の対象 network section を更新する。

- `published-at`: 新 package id
- `original-id`: 新 package id
- `upgrade-capability`: publish により新しく発行された UpgradeCap object ID

`published-at` と `original-id` が異なる状態にしない。新 package publish では旧 package lineage を引き継がないため、どちらも同じ新 package id を指す。

この変更を `main` に入れると dapp deploy や dev deploy が新 package id を読み始める。object id は workflow が `contracts/Published.toml` の package id と Sui events から導出するため、GitHub Variables へ手で登録しない。

### 5. GitHub Variables / Secrets 確認

GitHub Variables には、URL、network、residence root / source hash、World ID action など、package publish によって object id が変わらない値だけを置く。object id 系 Variables は stale になりやすいため使わない。

更新後に最低限確認するもの:

- `contracts/Published.toml` の target network section が新 package id を指す。
- `scripts/resolve_published_contract_ids.ts` が新 `AdminCap`、`VerifierRegistry`、`DisasterRegistry`、`AllowedResidenceCellRegistry`、floor census target を解決できる。
- repo / environment Variables に古い object id 系の値が残っていない。
- `SONARI_DEV_ADMIN_PRIVATE_KEY` が dev/testnet 用の新 admin key を保持し、ログに出ていない。

### 6. World ID action 更新

World developer portal で新 action を作成し、repo-level GitHub Variable `SONARI_WORLD_ID_ACTION` を同じ値へ更新する。issue #361 の前提では、既存使用済み action が `v1` / `v2` / `v4` / `v5` / `v6` / `v7` で、新規は `sonari_membership_register_v8` とする。

一致の確認対象:

| 面 | 設定先 |
| --- | --- |
| Portal | World developer portal の action |
| GitHub Actions | repo-level `SONARI_WORLD_ID_ACTION` |

値は必ず `sonari_membership_register_v<番号>` にする。`.github/workflows/aws-sonari-verifier-runner-dev-deploy.yml`、`.github/workflows/dapp-deploy.yml`、`scripts/membership_identity_live_gate.ts` が同じ形式を検証する。

### 7. dev deploy workflow による PCR 再登録

dev deploy workflow は EIF rebuild 後に PCR0/1/2 を読み、on-chain `VerifierRegistry` へ自動再登録する。issue #361 の前提では family 3 が earthquake、family 4 が membership identity である。

workflow 起動前の gate:

- `contracts/Published.toml` が新 package id。
- resolver が新 `AdminCap` と `VerifierRegistry` を Sui events から解決できる。
- `SONARI_DEV_ADMIN_PRIVATE_KEY` が新 `AdminCap` を操作できる dev/testnet admin key。
- `SONARI_WORLD_ID_ACTION` が Portal の action と一致。

workflow 成功後の確認:

- run summary の earthquake EIF PCR と membership identity EIF PCR が on-chain read-only check と一致する。
- `EEnclavePcrMismatch` / abort 21 が出ていない。
- `pnpm aws:post-deploy-guardrails` と `pnpm aws:check-idle` 相当の確認で Runner ASG、EC2、Watcher/Batch schedules が安全な状態に戻っている。

### 8. smoke / フロントエンド認証確認

地震系:

- `pnpm aws:smoke:earthquake-manual -- --stack sonari-verifier-runner-dev --region ap-northeast-1` を使う。
- `RelayerTarget` が新 package id の `accessor::create_disaster_event_and_campaign_from_signed_payload` を指す。
- `RelayerCategoryRegistry` と `RelayerCategoryPool` が新 `CategoryRegistry` / `EarthquakePool` を指す。
- `DisasterRegistry` が新 object で、古い registry への duplicate disaster event を見ていない。

個人認証系:

- dev stack が real proof mode の場合、World ID 認証済みユーザーがフロントエンドから実際の登録導線を実行し、request 生成、TEE 検証、Sui submit、dapp readback まで通ることを確認する。
- dapp が生成する proof の action と TEE が検証する `SONARI_WORLD_ID_ACTION` が同じである。
- `AllowedResidenceCellRegistry` が real residence root を持つため、`EInvalidResidenceCellProof` / abort 0 が出ない。
- fresh membership / fresh subject で確認する。既存 pass や同一 provider の再利用は `EIdentityProviderReplay` / abort 6 の原因になる。

## object ID / env 対応表

| 対象 | 出どころ | 利用方法 |
| --- | --- | --- |
| package ID | publish tx / `contracts/Published.toml` | `contracts/Published.toml` の `published-at` / `original-id`; deploy workflow と dapp はここから導出 |
| `AdminCap` | `GenesisObjectCreated` kind 1 | resolver output の `SONARI_ADMIN_CAP_ID` |
| `PauseState` | `GenesisObjectCreated` kind 2 | resolver output の `SONARI_IDENTITY_PAUSE_STATE_ID`, `SONARI_FLOOR_CENSUS_PAUSE_STATE` |
| `MainPool` | `GenesisObjectCreated` kind 3 | resolver output の `SONARI_FLOOR_CENSUS_MAIN_POOL` |
| `OperationsPool` | `GenesisObjectCreated` kind 4 | 寄付 / operations 系の別 deploy 対象。republish smoke では取り違え防止の照合対象 |
| `DonorRegistry` | `GenesisObjectCreated` kind 5 | 寄付 / dapp 側の別 deploy 対象。republish smoke では取り違え防止の照合対象 |
| `MembershipRegistry` | `GenesisObjectCreated` kind 6 | resolver output の `SONARI_MEMBERSHIP_REGISTRY_ID` |
| `VerifierRegistry` | `GenesisObjectCreated` kind 7 | resolver output の `SONARI_VERIFIER_REGISTRY_ID`, `RELAYER_VERIFIER_REGISTRY` |
| `IdentityRegistry` | `GenesisObjectCreated` kind 9 | resolver output の `SONARI_IDENTITY_REGISTRY_ID` |
| `CategoryRegistry` | `GenesisObjectCreated` kind 10 | resolver output の `SONARI_CATEGORY_REGISTRY_ID`, `RELAYER_CATEGORY_REGISTRY` |
| `EarthquakePool` | `GenesisObjectCreated` kind 11 | resolver output の `SONARI_EARTHQUAKE_CATEGORY_POOL_ID`, `FLOOR_CENSUS_CATEGORY_POOL` |
| `CellCountIndex` | `GenesisObjectCreated` kind 14 | resolver output の `SONARI_CELL_COUNT_INDEX_ID`, `FLOOR_CENSUS_CELL_COUNT_INDEX` |
| `DisasterRegistry` | `admin::create_disaster_registry` | resolver output の `RELAYER_REGISTRY` |
| `AllowedResidenceCellRegistry` | `admin::create_allowed_residence_cell_registry` | resolver output の `SONARI_ALLOWED_RESIDENCE_CELL_REGISTRY_ID` |
| floor census target | 新 package id を埋め込む文字列 | resolver output の `FLOOR_CENSUS_TARGET=<PACKAGE_ID>::accessor::set_floor_census` |
| dev admin private key secret | publish sender / dev admin key | `SONARI_DEV_ADMIN_PRIVATE_KEY` in environment `aws-sonari-verifier-runner-dev` |
| World ID action | Portal action bump | repo-level `SONARI_WORLD_ID_ACTION` |

## つまりどころ

| 症状 | 典型原因 | 確認 / 対処 |
| --- | --- | --- |
| `EEnclavePcrMismatch` / abort 21 | EIF rebuild 後の PCR0/1/2 と on-chain `VerifierRegistry` が不一致 | dev deploy workflow summary の PCR と on-chain config を比較する。resolver output の `SONARI_ADMIN_CAP_ID` / `SONARI_VERIFIER_REGISTRY_ID` と `SONARI_DEV_ADMIN_PRIVATE_KEY` が新 package に対応しているか確認して再 deploy する。 |
| `EInvalidResidenceCellProof` / abort 0 | `AllowedResidenceCellRegistry` が test / golden root、または dapp / TEE が古い registry を参照 | `AllowedResidenceCellRegistry` を real root `0x339601f3f8fc103fbbf526b39537235d7f6ad033a236f8c59f60498240a11ecc` で作成したことを readback する。 |
| World ID action mismatch | dapp proof action と TEE `SONARI_WORLD_ID_ACTION` が不一致 | Portal と repo-level `SONARI_WORLD_ID_ACTION` が同じ `sonari_membership_register_v<N>` か確認する。 |
| `EIdentityProviderReplay` / abort 6 | 同一 lineage / provider の重複登録、または古い membership pass の再利用 | new package の空 `IdentityRegistry` と fresh membership / fresh subject を使う。action bump だけでは on-chain replay 条件を解除できない場合がある。 |
| old registry への duplicate disaster event | relayer env が古い `DisasterRegistry` を指す | resolver output の `RELAYER_REGISTRY` と stack parameter `RelayerRegistry` が新 `DisasterRegistry` か確認する。 |
| Sui `keytool import` が `client.yaml` を要求する | import 先の Sui config directory が未初期化 | `.local/sonari-dev/sui_wallets/admin/` 配下に wallet config を作り、`sui client --client.config <path>` が同じ config を読むよう統一する。 |
| Register 成功後 Verify が別 path の `client.yaml` を読んで失敗 | publish / register と verify / smoke で `SUI_CLIENT_CONFIG` が違う | shell、script、workflow の `SUI_CLIENT_CONFIG` / `--client.config` を同じ `.local/sonari-dev/sui_wallets/admin/sui_config.yaml` に揃える。 |
| `Published.toml` は新しいが dapp / AWS が古い ID を読む | resolver 失敗、古い stack parameter の残存、または deploy 未実行 | `scripts/resolve_published_contract_ids.ts` の出力と stack parameter を照合し、dev deploy / dapp deploy を新 commit で実行する。 |

## 完了条件

republish 完了は、publish transaction の成功だけでは判定しない。次をすべて確認して完了とする。

- `contracts/Published.toml` の `published-at` / `original-id` が新 package id で、`upgrade-capability` も新値。
- `scripts/resolve_published_contract_ids.ts` が対応表の object ID を新 package から解決できる。
- `DisasterRegistry` と `AllowedResidenceCellRegistry` が post-publish 作成済み。
- `AllowedResidenceCellRegistry` の residence root が production 用 real root。
- World ID action が Portal と repo-level `SONARI_WORLD_ID_ACTION` で一致。
- dev deploy workflow が verifier family 3 / 4 の PCR を再登録し、read-only check が rebuilt EIF の PCR と一致。
- earthquake smoke が新 package id、新 `VerifierRegistry`、新 `DisasterRegistry`、新 `CategoryRegistry`、新 `EarthquakePool` を参照して成功。
- identity / membership のフロントエンド実行確認では、新 `IdentityRegistry`、新 `MembershipRegistry`、新 `AllowedResidenceCellRegistry`、一致した `WORLD_ID_ACTION` を参照し、ユーザー操作から on-chain 反映と dapp 表示まで通る。
- GitHub Actions を再実行する場合は、失敗箇所が publish、env 張り替え、PCR 再登録、relayer submit、floor census、dapp action のどこかを切り分け、古い ID へ戻して通すのではなく新 ID 配線を修正する。

## この runbook で実行しないこと

この文書の追加自体では、contract publish、AWS / GitHub env 更新、World ID Portal 変更、GitHub Actions dispatch、Sui / AWS smoke は実行しない。これらは issue #361 の実機作業時に、最新の repo 状態と credentials を確認してから行う。
