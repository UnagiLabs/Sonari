# Sonari Verifiers

`nautilus/verifiers` は、Sonari が外部事実を検証して Sui contract に渡せる署名済み payload を作る領域です。

ここにある verifier は、worker、watcher、relayer、UI、外部 API response をそのまま信頼しません。contract-facing な値は、TEE または verifier 境界で再取得、検証、正規化、BCS encode、署名されます。

## 何を置く場所か

| フォルダ | 役割 |
| --- | --- |
| `common/` | verifier family をまたぐ TypeScript 契約と shared runner helper |
| `earthquake/` | USGS 地震 source を検証し、災害 event / affected cells の payload を作る verifier |
| `membership/` | Membership SBT の本人確認や membership metadata を検証する verifier family |
| `shared-tee/` | Rust TEE crate 間で共有する署名、hash、seed、artifact helper |

## 信頼境界

Verifier の信頼境界は、署名済み result です。

- watcher / runner / relayer は、候補検出、queue 投入、実行起動、配送を担当する。
- TEE / verifier は、source 再取得、検証、正規化、payload 生成、署名を担当する。
- relayer は finalized payload を配送するだけで、payload の意味を変えない。
- Move contract は、署名、version、intent、field order、payload constraints など contract 側で検証できる情報だけを信頼する。

## verifier family

`earthquake` と `membership`（identity family）は別の信頼境界です。

地震 verifier は災害 event と affected cells を扱います。Identity（membership）verifier は本人確認、居住セル、将来の属性検証を扱います。両者の payload、source、rejection rule、署名 key、on-chain apply path は混ぜません。

> 用語: ディレクトリ名は `membership/` ですが、verifier family の正式名は `identity`（Move `verifier_family` / TEE `VERIFIER_FAMILY` / intent ともに identity）です。本書では family を指すときは `identity`、SBT / runner の crate を指すときは `membership` と書き分けます。

## 採番表（family / config_key / attestation label / intent）

新しい verifier を共有基盤に載せるときの採番は、ここ 1 箇所に集約します。コード側の正本は `sonari-tee-core` の `registry` module（`shared-tee/src/registry.rs`）にあり、その uniqueness テストが `config_key` と attestation label の重複を防ぎます。この表は registry の値をミラーするだけで、別の場所に二重定義を増やしません。

| verifier | family (u8) | config_key (u64) | attestation public-key label | intent |
| --- | --- | --- | --- | --- |
| earthquake | 3 | 1 | `sonari-earthquake-attestation-public-key` | u8 enum tag `1`（`SONARI_EARTHQUAKE_ORACLE`、BCS payload 先頭の `u8`） |
| identity (membership) | 4 | 2 | `sonari-membership-attestation-public-key` | UTF-8 string `SONARI_IDENTITY_VERIFICATION_V1`（BCS payload 先頭の intent 文字列） |

- `family`（u8）は Move `metadata_verifier`（`contracts/sources/metadata_verifier.move`）の `verifier_family` と一致させます（earthquake oracle = 3, identity = 4）。
- `config_key`（u64）は on-chain `VerifierRegistry` の config key です。
- attestation label は enclave が attestation public key を導出するために署名する byte string で、`sonari-tee-core::registry` の `*_ATTESTATION_PUBLIC_KEY_LABEL` 定数が正本です。
- intent は署名対象 payload の domain separation marker です。2 family で表現が構造的に異なる（earthquake は BCS 先頭の `u8` enum tag、identity は BCS 先頭の UTF-8 文字列）ので、registry の `VerifierIntent` enum がその形まで記録します。

### config_key 採番規約

`config_key` は verifier ごとに **+1 ずつ採番し、再利用しません**。earthquake = 1, identity = 2, **次の verifier は 3 を予約**します（`sonari-tee-core::registry::NEXT_VERIFIER_CONFIG_KEY`）。新しい verifier を足すときは registry に 1 行追加し、`NEXT_VERIFIER_CONFIG_KEY` を次の値へ更新し、この表に 1 行足します。

## North Star: handler を 1 つ書くだけで載る

新 verifier の verifier 固有実装は **`sonari-tee-core::ProcessDataHandler` を 1 つ書くこと**に集約します。

`ProcessDataHandler::process` は **source 再取得・検証・正規化・canonical BCS payload の生成だけ**を担い、**署名・attestation・ephemeral key 生成・registration_metadata 注入・VSOCK/HTTP I/O は一切含みません**。それらはすべて共通基盤側（`sonari-tee-core::enclave` の shared server と `main.rs` の orchestration）が担当します。handler は signing key も transport state も持たず、verified/finalized 結果は `ProcessOutput::Signable`（署名対象 BCS bytes を渡す）、それ以外は `ProcessOutput::Unsigned`（そのまま返す）として返すだけです。この責務境界が共有基盤の North Star です。

## 新 verifier 追加チェックリスト

共有 EC2 / Nitro 基盤に新しい verifier を載せるときに足すもの一覧です。verifier 固有ロジックは TEE handler 1 つに収め、残りは共通基盤の設定追加で済むことを意図しています。

- [ ] **採番**: 上の採番表に 1 行追加し、`sonari-tee-core::registry` に entry を追加（`config_key` は `NEXT_VERIFIER_CONFIG_KEY`、`NEXT_VERIFIER_CONFIG_KEY` を +1）。uniqueness テストが green であること。
- [ ] **Move**（`contracts/sources/metadata_verifier.move` ほか）: `verifier_family` 定数、`*_CONFIG_KEY`、config 登録関数（`create_*_verifier_config` / `update_*_verifier_config_pcrs`）、admin 入口（`contracts/sources/admin.move`）、署名検証 / apply path（payload module と `verify_*`）。#127 の family-generic 化に倣う。
- [ ] **verifier_kind 定義**（`nautilus/verifiers/common/contracts/src/index.ts` の `VERIFIER_KINDS` / `parseVerifierKind`、`scripts/build_aws_sonari_verifier_runner_lambda.ts` の分岐）に新 kind を追加。
- [ ] **TEE handler crate**（`nautilus/verifiers/<name>/tee/`）: `ProcessDataHandler` 実装を 1 つ書く（domain logic のみ。署名・attestation・I/O は書かない）。`main.rs` は shared server へ handler と attestation label / orchestration 設定を渡すだけ。
- [ ] **runner**（`nautilus/verifiers/<name>/runner/` または watcher、`infra/aws/<name>-runner/`）: 候補検出・queue・実行起動・配送。
- [ ] **build script**（`scripts/build_aws_*` と `package.json` の `build:aws-*-tee-artifact` / `build:aws-*-eif` script）に新 verifier の artifact / EIF build を追加。
- [ ] **CFn parameter**（`infra/aws/<name>-runner/template.yaml`、共有なら `infra/aws/sonari-verifier-runner/template.yaml`）に verifier 固有 parameter を追加。
- [ ] **GitHub Actions step**（`.github/workflows/aws-sonari-verifier-runner-dev-deploy.yml`）に TEE artifact / EIF build・PCR 読み取り・artifact upload の step を追加。
- [ ] **admin tx 手順**（`infra/README.md`）に新 verifier config の登録（PCR0/1/2 を `VerifierRegistry` に登録する admin tx）手順を追記。
- [ ] **テスト / golden vector**: BCS payload・field order・enum 値・golden vector を Rust / TypeScript / Move 横断で更新。

## 変更時の注意

BCS payload、field order、enum 値、署名対象 bytes、Merkle root、golden vector は Rust / TypeScript / Move をまたぐ契約です。変更する場合は、schema または docs、fixture / golden vector、Rust / TypeScript / Move のテストを一緒に更新してください。

通常の実装確認は、変更した package の test から始め、影響範囲に応じて root の check / test まで広げます。
