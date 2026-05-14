# Sonari 技術スタックとモノレポ構成

Sonari MVPは、フロントエンド、Nautilus Earthquake Oracle、Sui Move packageをルート直下の機能単位で分けるモノレポ構成にします。初期開発では後方互換性よりも、責任分界の明確さと提出物としての分かりやすさを優先します。

## ルートディレクトリ方針

```txt
dapp/
  src/
  public/

nautilus_disaster_oracle/
  tee/
  watcher/
  relayer/
  shared/
  fixtures/

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

| ディレクトリ | 役割 | 主な技術 |
| --- | --- | --- |
| `dapp/` | フロントエンド本体。Dashboard、Claim、DisasterEvent表示、Wallet接続を担当する。 | React / Next.js、TypeScript、Sui dApp Kit |
| `nautilus_disaster_oracle/` | Earthquake Oracle機能本体。TEE、Watcher、Relayer、Oracle内部共有コードをまとめる。 | Rust、TypeScript、Nautilus、Cloudflare Workers |
| `nautilus_disaster_oracle/tee/` | Nautilus / TEE内で動く検証・署名実装。外部source再取得、Band判定、H3生成、Merkle root生成、Payload生成、署名を担当する。 | Rust、serde、reqwest、bcs、sha2、h3oまたはh3ron |
| `nautilus_disaster_oracle/watcher/` | 軽量監視プロセス。Cron、USGS recent earthquakes API取得、D1状態管理、Queue投入、TEE起動API呼び出し、手動投入APIを担当する。 | Cloudflare Workers、TypeScript、Wrangler、D1 / Queues |
| `nautilus_disaster_oracle/relayer/` | Nautilus / TEEが生成した署名済みPayloadをSuiへ投稿するプロセス。Payload内容は変更しない。 | TypeScriptまたはRust、Sui SDK |
| `nautilus_disaster_oracle/shared/` | Oracle内部のTypeScript共有型、定数、validator。dApp向け共有UIや全体設定は置かない。 | TypeScript |
| `nautilus_disaster_oracle/fixtures/` | USGS / JMAの再現用サンプルデータ。TEE、Watcher、Relayerの共通テスト入力として使う。 | JSON |
| `contracts/` | Sui Move package。追加階層を挟まず、Move packageを直下に置く。 | Sui Move |
| `packages/` | Sonari全体で共有するUI、configだけを置く。Oracle専用コードは置かない。 | TypeScript |
| `docs/` | 仕様書、説明資料、提出用ドキュメント。 | Markdown、HTML |
| `schemas/` | Payload、Merkle leaf、source manifest、affected cellsの仕様。Rust、TypeScript、Moveの構造ズレを防ぐ。 | Markdown、JSON Schema |
| `scripts/` | ローカル実行、デプロイ、登録、補助作業用スクリプト。 | shell、TypeScript |

## 採用方針

- 機能単位のルート構成を優先し、汎用的な中間ディレクトリは使わない。
- dAppは `dapp/` に置き、Dashboard、Claim、DisasterEvent表示、Wallet接続を同じプロダクト面として扱う。
- Nautilus Earthquake Oracleの専用コードは `nautilus_disaster_oracle/` に閉じる。
- Oracle内部の共有型・定数・validatorは `nautilus_disaster_oracle/shared/` に置き、`packages/` へ漏らさない。
- Move packageは `contracts/` 直下に置き、追加階層は作らない。
- `packages/` は全体共有のUI / configに限定し、ドメイン固有ロジックの置き場にしない。

## Sonari MVPの主要技術

| 領域 | 技術 | 用途 |
| --- | --- | --- |
| Frontend | React / Next.js、TypeScript、Sui dApp Kit | ユーザー向けDashboard、Claim UI、DisasterEvent表示、Wallet接続 |
| Oracle Watcher | Cloudflare Workers、Wrangler、D1 / Queues | USGS候補検出、D1 primary state管理、TEE起動 |
| Oracle TEE | Rust、Nautilus、AWS Nitro Enclaves | 外部source再検証、Payload生成、秘密鍵隔離、署名 |
| Relayer | Sui SDK、TypeScriptまたはRust | 署名済みPayloadのSui投稿 |
| Contracts | Sui Move | DisasterEvent、署名Payload検証、revision管理、Claim接続用root保存 |
| Fixtures / Tests | JSON fixture、Rust / TypeScript test runner | USGS / JMA入力の再現、Oracle判定の検証 |
