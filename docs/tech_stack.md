# Sonari 技術スタックとモノレポ構成

Sonari MVP は、フロントエンド、Nautilus verifier family、Sui Move package をルート直下の機能単位で分けるモノレポ構成にする。初期開発では後方互換性よりも、責任分界の明確さと提出物としての分かりやすさを優先する。

## ルートディレクトリ方針

```txt
dapp/
  src/
  public/

nautilus/verifiers/disaster/
  tee/
  watcher/
  relayer/
  shared/
  fixtures/

nautilus/verifiers/membership/
  shared/
  tee/
  fixtures/
  verifiers/

contracts/
  Move.toml
  sources/

packages/
  ui/
  config/

docs/

schemas/

scripts/
```

## Package Manager / Workspace 方針

TypeScript package manager は `pnpm@10.27.0` を採用する。root `package.json` は workspace の集約コマンドだけを持ち、実装単位は `pnpm-workspace.yaml` で `dapp/*`、`packages/*`、`nautilus/verifiers/*/*` を対象にする。

Nautilus Disaster Oracle の TypeScript package は `nautilus/verifiers/disaster/shared`、`nautilus/verifiers/disaster/watcher`、`nautilus/verifiers/disaster/relayer` に分ける。`shared` は Oracle 内部専用の型契約・定数・validator を持つ workspace package とし、`watcher` と `relayer` から `workspace:*` で参照する。

`nautilus/verifiers/membership/` は Membership Pass metadata verifier family の置き場である。residence verifier と student verifier はここに置く。MVP では docs-only design、dummy verifier、shared type placeholder、fixture placeholder を中心にし、production schema、migration、runner、relayer、Sui 投稿処理は必要になった時点で追加する。

複数 verifier family で共通化する runner / relayer / shared utilities は、実装重複が見えた時点で `nautilus/` 配下へ切り出す。初期段階では premature abstraction を避け、disaster verifier と membership verifier の責務を分けて保つ。

## ディレクトリ別役割

| ディレクトリ | 役割 | 主な技術 |
| --- | --- | --- |
| `dapp/` | Dashboard、Donation、Membership Pass、Claim、Program / Campaign 表示、Wallet 接続。 | React / Next.js、TypeScript、Sui dApp Kit |
| `nautilus/verifiers/disaster/` | Disaster verifier family。地震イベント、対象セル root、署名 payload を生成する。 | Rust、TypeScript、Nautilus、Cloudflare Workers |
| `nautilus/verifiers/disaster/tee/` | Nautilus / TEE 内で動く検証・署名実装。外部 source 再取得、Band 判定、H3 生成、Merkle root、Payload、署名を担当する。 | Rust、serde、reqwest、bcs、sha2、h3o または h3ron |
| `nautilus/verifiers/disaster/watcher/` | 軽量監視プロセス。USGS 候補検出、D1 状態管理、Queue 投入、TEE 起動 API 呼び出し、手動投入 API を担当する。 | Cloudflare Workers、TypeScript、Wrangler、D1 / Queues |
| `nautilus/verifiers/disaster/relayer/` | Nautilus / TEE が生成した署名済み payload を Sui へ投稿する。Payload 内容は変更しない。 | TypeScript または Rust、Sui SDK |
| `nautilus/verifiers/disaster/shared/` | Disaster verifier 内部の TypeScript 共有型、定数、validator。 | TypeScript |
| `nautilus/verifiers/disaster/fixtures/` | USGS / JMA の再現用サンプルデータ。TEE、Watcher、Relayer の共通テスト入力。 | JSON |
| `nautilus/verifiers/membership/` | Membership Pass metadata verifier family。residence / student verifier の docs、shared types、fixtures、dummy implementation を置く。 | TypeScript、Rust future、Nautilus |
| `nautilus/verifiers/membership/shared/` | `ResidenceMetadataUpdate`、`StudentMetadataUpdate`、confidence / risk bucket などの placeholder shared types。 | TypeScript |
| `nautilus/verifiers/membership/verifiers/residence/` | Web MVP residence confidence scoring verifier。raw evidence を秘匿し、Pass metadata update を生成する。 | TypeScript dummy first、Rust / Nautilus future |
| `nautilus/verifiers/membership/verifiers/student/` | Student status verifier。学籍番号や学校メール raw value をオンチェーンに出さず、Student metadata update を生成する。 | TypeScript dummy first、Rust / Nautilus future |
| `contracts/` | Sui Move package。generic Program / Pool / Membership / Claim / Nautilus result verification 基盤を直下に置く。 | Sui Move |
| `packages/` | Sonari 全体で共有する UI、config だけを置く。Oracle / verifier 専用コードは置かない。 | TypeScript |
| `docs/` | 仕様書、説明資料、提出用ドキュメント。 | Markdown、HTML |
| `schemas/` | repository root の共通仕様。Disaster Oracle v1 payload、Merkle leaf、manifest、affected cells の仕様を定義する。 | Markdown、JSON Schema |
| `scripts/` | ローカル実行、デプロイ、登録、補助作業用スクリプト。 | shell、TypeScript |

## 採用方針

- 機能単位のルート構成を優先し、汎用的な中間ディレクトリは使わない。
- TypeScript workspace は pnpm で管理し、root から `pnpm typecheck`、`pnpm test`、`pnpm test:oracle` を実行できる状態を保つ。
- dApp は `dapp/` に置き、Dashboard、Donation、Membership Pass、Claim、Program / Campaign 表示、Wallet 接続を同じプロダクト面として扱う。
- Disaster verifier 専用コードは `nautilus/verifiers/disaster/` に閉じる。
- Membership verifier 専用コードは `nautilus/verifiers/membership/` に閉じる。
- Oracle / verifier 内部の shared 型・定数・validator は各 verifier family の `shared/` に置き、`packages/` へ漏らさない。
- `schemas/` は root 共通仕様として扱い、Disaster Oracle 実装と Move package の両方から参照する。
- Move package は `contracts/` 直下に置き、追加階層は作らない。
- `packages/` は全体共有の UI / config に限定し、ドメイン固有ロジックの置き場にしない。

## Sonari MVP の主要技術

| 領域 | 技術 | 用途 |
| --- | --- | --- |
| Frontend | React / Next.js、TypeScript、Sui dApp Kit | Dashboard、Donation、Membership Pass、Claim UI、Program / Campaign 表示、Wallet 接続 |
| Disaster Watcher | Cloudflare Workers、Wrangler、D1 / Queues | USGS 候補検出、D1 primary state 管理、TEE 起動 |
| Disaster TEE | Rust、Nautilus、AWS Nitro Enclaves | 外部 source 再検証、対象セル root 生成、Payload 生成、秘密鍵隔離、署名 |
| Disaster Relayer | Sui SDK、TypeScript または Rust | 署名済み Disaster Payload の Sui 投稿 |
| Membership Verifiers | TypeScript dummy first、Nautilus / Rust future | Residence / Student metadata update 生成 |
| Contracts | Sui Move | Program、Campaign、Pool、Membership Pass、Nautilus result verification、Claim / Payout、DisasterEvent 接続 |
| Fixtures / Tests | JSON fixture、Rust / TypeScript test runner | USGS / JMA / residence / student 入力の再現、verifier 判定の検証 |

## Contracts 方針

Contracts は DisasterEvent 専用 package ではなく、generic Program / Pool / Membership / Claim 基盤として実装する。

中心 module:

- `program`
- `pools`
- `donation`
- `membership`
- `metadata_verifier`
- `payout_policy`
- `claim`
- `disaster_event`
- `payload_v1`
- `affected_cell`
- `admin`

`disaster_event` と `affected_cell` は Disaster Relief Program の verifier 接続であり、generic Claim の唯一の基盤ではない。Student Aid など災害以外の Program は、Membership Pass と Student metadata update を使って同じ Claim / Payout 基盤に接続する。
