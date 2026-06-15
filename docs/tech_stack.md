# Sonari Tech Stack and Monorepo Layout

The Sonari MVP uses a monorepo that separates the frontend, the Nautilus verifier family, and the Sui Move package into feature units directly under the root. In early development we prioritize clear separation of responsibilities and clarity as a submission over backward compatibility.

## Root Directory Policy

```txt
dapp/
nautilus/verifiers/earthquake/
nautilus/verifiers/membership/
contracts/
packages/
docs/
schemas/
scripts/
infra/
```

`docs/` holds only project-wide documents for Sonari as a whole — architecture / product / privacy / roadmap / business logic and the like. Verifier-specific specs, operational design, AWS configuration, and development notes go in the README under each implementation directory.

## Package Manager / Workspace Policy

The TypeScript package manager is `pnpm@10.27.0`. The root `package.json` holds only the workspace aggregation commands, and the implementation units are targeted via `pnpm-workspace.yaml` covering `dapp/*`, `packages/*`, and `nautilus/verifiers/*/*`.

The Earthquake verifier TypeScript packages are split into `@sonari/earthquake-shared`, `@sonari/earthquake-watcher`, `@sonari/earthquake-relayer`, and `@sonari/earthquake-runner`. The Membership verifier packages use membership-specific names.

The runner / relayer / shared utilities that are common across multiple verifier families are extracted under `nautilus/` once the implementation duplication becomes visible. In the early stage we avoid premature abstraction and keep the responsibilities of the earthquake verifier and the membership verifier separate.

## Nautilus Verifiers

Verifier-specific details live with each verifier implementation.

- Earthquake verifier: `nautilus/verifiers/earthquake/README.md`
- Membership verifier: `nautilus/verifiers/membership/README.md`
- Sonari verifier AWS runner: `infra/aws/sonari-verifier-runner/README.md`

## Role by Directory

| Directory | Role | Main technologies |
| --- | --- | --- |
| `dapp/` | Dashboard, Donation, Membership Pass, Claim, Program / Campaign display, Wallet connection. | React / Next.js, TypeScript, Sui dApp Kit |
| `nautilus/verifiers/earthquake/` | The earthquake verifier for the Sonari MVP. Generates earthquake events, the target-cell root, and the signed payload. | Rust, TypeScript, Nautilus, AWS Lambda |
| `nautilus/verifiers/membership/` | The Membership Pass metadata verifier family. Holds the docs, shared types, fixtures, and implementation for the residence / student / migration verifiers. | TypeScript, Rust future, Nautilus |
| `contracts/` | The Sui Move package. Holds the generic Program / Pool / Membership / Claim / Nautilus result verification foundation. | Sui Move |
| `packages/` | Holds only the UI and config shared across Sonari as a whole. No verifier-specific code. | TypeScript |
| `docs/` | Project-wide specs, explanatory materials, and submission documents. | Markdown, HTML |
| `schemas/` | The shared spec at the repository root. Defines the cross-language contract for payload, Merkle leaf, manifest, and affected cells. | Markdown, JSON Schema |
| `scripts/` | Scripts for local execution, deployment, registration, and auxiliary work. | shell, TypeScript |
| `infra/` | Shared infrastructure templates such as AWS. The verifier runner goes in a directory named after the unified runner. | CloudFormation |

## Adoption Policy

- Prioritize a feature-unit root layout; do not use generic intermediate directories.
- Manage the TypeScript workspace with pnpm, and keep it in a state where `pnpm typecheck`, `pnpm test`, and `pnpm test:oracle` can be run from the root.
- Manage the Rust root quality gate via `pnpm check:rust`, which runs `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings`. This treats Clippy warnings in test targets including `#[cfg(test)]` as failures, not just in ordinary code.
- Place the dApp in `dapp/`, treating Dashboard, Donation, Membership Pass, Claim, Program / Campaign display, and Wallet connection as one and the same product surface.
- Confine earthquake-verifier-specific code to `nautilus/verifiers/earthquake/`.
- Confine membership-verifier-specific code to `nautilus/verifiers/membership/`.
- Place shared types / constants / validators internal to a verifier in each verifier family's `shared/`, and do not leak them into `packages/`.
- Treat `schemas/` as the root-shared spec, referenced from both the verifier implementations and the Move package.
- Place the Move package directly under `contracts/` and do not create additional layers.
- Limit `packages/` to globally shared UI / config, and do not make it a home for domain-specific logic.

## Key Technologies of the Sonari MVP

| Area | Technology | Use |
| --- | --- | --- |
| Frontend | React / Next.js, TypeScript, Sui dApp Kit | Dashboard, Donation, Membership Pass, Claim UI, Program / Campaign display, Wallet connection |
| Earthquake Watcher | AWS Lambda, Lambda local test, DynamoDB / Step Functions | USGS candidate detection, DynamoDB primary state management, TEE startup |
| Earthquake TEE | Rust, Nautilus, AWS Nitro Enclaves | External source re-verification, target-cell root generation, payload generation, private-key isolation, signing |
| Earthquake Relayer | Sui SDK, TypeScript | Preview / dry-run / explicit submit of the signed Earthquake payload |
| Membership Verifiers | TypeScript dummy first, Nautilus / Rust future | Residence / Student / Migration metadata update generation |
| Contracts | Sui Move | Program, Campaign, Pool, Membership Pass, Nautilus result verification, Claim / Payout, DisasterEvent connection |
| Fixtures / Tests | JSON fixture, Rust / TypeScript test runner | Reproduction of USGS / residence / student inputs, verification of verifier decisions |

## Contracts Policy

The Contracts are implemented not as a DisasterEvent-specific package, but as a generic Program / Pool / Membership / Claim foundation.

`DisasterEvent`, `disaster_event`, and `DisasterRegistry` are kept as general terms that can also accommodate multiple future disaster types. The MVP verifier implementation name, package name, AWS runner name, and the implementation designation in the README are unified to `earthquake`.

---

# Sonari 技術スタックとモノレポ構成（日本語）

Sonari MVP は、フロントエンド、Nautilus verifier family、Sui Move package をルート直下の機能単位で分けるモノレポ構成にする。初期開発では後方互換性よりも、責任分界の明確さと提出物としての分かりやすさを優先する。

## ルートディレクトリ方針

```txt
dapp/
nautilus/verifiers/earthquake/
nautilus/verifiers/membership/
contracts/
packages/
docs/
schemas/
scripts/
infra/
```

`docs/` は Sonari 全体の architecture / product / privacy / roadmap / business logic など、プロジェクト横断の文書だけを置く。Verifier 固有の仕様、運用設計、AWS 構成、開発メモは実装ディレクトリ配下の README に置く。

## Package Manager / Workspace 方針

TypeScript package manager は `pnpm@10.27.0` を採用する。root `package.json` は workspace の集約コマンドだけを持ち、実装単位は `pnpm-workspace.yaml` で `dapp/*`、`packages/*`、`nautilus/verifiers/*/*` を対象にする。

Earthquake verifier の TypeScript package は `@sonari/earthquake-shared`、`@sonari/earthquake-watcher`、`@sonari/earthquake-relayer`、`@sonari/earthquake-runner` に分ける。Membership verifier の package は membership 固有名にする。

複数 verifier family で共通化する runner / relayer / shared utilities は、実装重複が見えた時点で `nautilus/` 配下へ切り出す。初期段階では premature abstraction を避け、earthquake verifier と membership verifier の責務を分けて保つ。

## Nautilus Verifiers

Verifier-specific details live with each verifier implementation.

- Earthquake verifier: `nautilus/verifiers/earthquake/README.md`
- Membership verifier: `nautilus/verifiers/membership/README.md`
- Sonari verifier AWS runner: `infra/aws/sonari-verifier-runner/README.md`

## ディレクトリ別役割

| ディレクトリ | 役割 | 主な技術 |
| --- | --- | --- |
| `dapp/` | Dashboard、Donation、Membership Pass、Claim、Program / Campaign 表示、Wallet 接続。 | React / Next.js、TypeScript、Sui dApp Kit |
| `nautilus/verifiers/earthquake/` | Sonari MVP の地震 verifier。地震イベント、対象セル root、署名 payload を生成する。 | Rust、TypeScript、Nautilus、AWS Lambda |
| `nautilus/verifiers/membership/` | Membership Pass metadata verifier family。residence / student / migration verifier の docs、shared types、fixtures、実装を置く。 | TypeScript、Rust future、Nautilus |
| `contracts/` | Sui Move package。generic Program / Pool / Membership / Claim / Nautilus result verification 基盤を置く。 | Sui Move |
| `packages/` | Sonari 全体で共有する UI、config だけを置く。Verifier 固有コードは置かない。 | TypeScript |
| `docs/` | プロジェクト全体の仕様、説明資料、提出用ドキュメント。 | Markdown、HTML |
| `schemas/` | repository root の共通仕様。Payload、Merkle leaf、manifest、affected cells の言語横断契約を定義する。 | Markdown、JSON Schema |
| `scripts/` | ローカル実行、デプロイ、登録、補助作業用スクリプト。 | shell、TypeScript |
| `infra/` | AWS などの共有インフラテンプレート。Verifier runner は統合 runner 名のディレクトリへ置く。 | CloudFormation |

## 採用方針

- 機能単位のルート構成を優先し、汎用的な中間ディレクトリは使わない。
- TypeScript workspace は pnpm で管理し、root から `pnpm typecheck`、`pnpm test`、`pnpm test:oracle` を実行できる状態を保つ。
- Rust の root 品質ゲートは `pnpm check:rust` で管理し、`cargo fmt --all --check` と `cargo clippy --workspace --all-targets -- -D warnings` を実行する。これにより通常コードだけでなく `#[cfg(test)]` を含む test target の Clippy warning も失敗扱いにする。
- dApp は `dapp/` に置き、Dashboard、Donation、Membership Pass、Claim、Program / Campaign 表示、Wallet 接続を同じプロダクト面として扱う。
- Earthquake verifier 専用コードは `nautilus/verifiers/earthquake/` に閉じる。
- Membership verifier 専用コードは `nautilus/verifiers/membership/` に閉じる。
- Verifier 内部の shared 型・定数・validator は各 verifier family の `shared/` に置き、`packages/` へ漏らさない。
- `schemas/` は root 共通仕様として扱い、verifier 実装と Move package の両方から参照する。
- Move package は `contracts/` 直下に置き、追加階層は作らない。
- `packages/` は全体共有の UI / config に限定し、ドメイン固有ロジックの置き場にしない。

## Sonari MVP の主要技術

| 領域 | 技術 | 用途 |
| --- | --- | --- |
| Frontend | React / Next.js、TypeScript、Sui dApp Kit | Dashboard、Donation、Membership Pass、Claim UI、Program / Campaign 表示、Wallet 接続 |
| Earthquake Watcher | AWS Lambda、Lambda local test、DynamoDB / Step Functions | USGS 候補検出、DynamoDB primary state 管理、TEE 起動 |
| Earthquake TEE | Rust、Nautilus、AWS Nitro Enclaves | 外部 source 再検証、対象セル root 生成、Payload 生成、秘密鍵隔離、署名 |
| Earthquake Relayer | Sui SDK、TypeScript | 署名済み Earthquake payload の preview / dry-run / 明示 submit |
| Membership Verifiers | TypeScript dummy first、Nautilus / Rust future | Residence / Student / Migration metadata update 生成 |
| Contracts | Sui Move | Program、Campaign、Pool、Membership Pass、Nautilus result verification、Claim / Payout、DisasterEvent 接続 |
| Fixtures / Tests | JSON fixture、Rust / TypeScript test runner | USGS / residence / student 入力の再現、verifier 判定の検証 |

## Contracts 方針

Contracts は DisasterEvent 専用 package ではなく、generic Program / Pool / Membership / Claim 基盤として実装する。

`DisasterEvent`、`disaster_event`、`DisasterRegistry` は将来の複数災害種類にも対応できる総称として残す。MVP の verifier 実装名、package 名、AWS runner 名、README 上の実装呼称は `earthquake` に統一する。
