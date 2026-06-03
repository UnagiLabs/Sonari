# Repository Guidelines

## 基本方針

作業を始める前に、必ず現在のリポジトリの状態を確認してください。古い前提や記憶に頼らず、実際のコード、テスト、設定ファイル、ドキュメントを根拠に判断します。

このファイルには、コードベースを見れば分かるフォルダ構成やコマンド一覧を詳しく書かず、Codex が判断を誤りやすいプロジェクト固有のルール、設計方針、レビュー基準を中心に記載します。詳細は `docs`、`schemas`、`package.json`、`Move.toml`、`Cargo.toml`、`tsconfig`、Biome 設定などを確認してください。

Sonari は現在 MVP 開発段階です。初期開発では後方互換性を優先せず、明確な責務分離、シンプルな設計、実装品質を優先してください。必要であれば破壊的変更、ファイル構成の変更、仕様整理を行って構いません。ただし、変更理由と影響範囲は PR や作業メモで明確に説明してください。

## 作業前の確認

実装前に、対象領域に関係する `package.json`、`Cargo.toml`、`Move.toml`、`tsconfig`、Biome 設定、schemas、docs、既存テスト、README、近い実装パターンを確認してください。

フォルダ名やファイル名だけで責務を推測せず、実装内容とテストを確認してから変更してください。設定や script は更新される可能性があるため、検証コマンドも記憶ではなく現在の設定から選んでください。

## 信頼境界

Oracle / verifier / relayer / contract の責務を混ぜないでください。

- Worker / watcher は、候補検出、キュー投入、状態管理、外部実行の起動を担当します。
- TEE / verifier は、外部 source の再取得、検証、正規化、Merkle root、BCS payload、署名を担当します。
- Relayer は、finalized payload を配送するだけです。payload の意味を変更してはいけません。
- Move contract は、worker、relayer、UI、外部 API を信頼してはいけません。署名済み finalized payload など、contract 側で検証可能なデータのみを信頼します。

この境界をまたぐ変更は、明示的に設計変更として扱い、理由と影響範囲を説明してください。

## Cross-language Contract

schemas、BCS payload、field order、enum 値、signature bytes、Merkle root、golden vector は Rust / TypeScript / Move をまたぐ契約です。

これらを安易に変更しないでください。変更する場合は、必ず変更理由を明記し、schema または docs、fixture / golden vector、影響する Rust / TypeScript / Move のテストを更新してください。PR には互換性への影響を書いてください。

既存の `oracle_version` に紐づく payload の field order と binary encoding は、明示的に新 version を定義する場合を除き immutable contract として扱ってください。

## TypeScript 実装ルール

TypeScript は untyped JavaScript として書かず、境界での検証と型安全性を重視してください。

- `any` は原則使わない。外部入力には `unknown` を使い、明示的に parse / validate する。
- HTTP request、environment variable、offchain state row、queue message、fixture JSON、外部 API response は境界で検証する。
- parse / normalize / business logic を分離する。
- 決定的な変換処理は、小さな pure function に分ける。
- 隠れた global state を避け、依存関係は可能な限り明示的に渡す。
- 重要な env 不備や不正値は fail-closed にする。安全でない fallback をしない。
- success path だけでなく、malformed input、retry、failure path、boundary condition をテストする。
- 型チェックや lint を通すために設定を弱めない。
- 新しい runtime dependency は必要性を説明できる場合のみ追加する。

package の挙動を変えた場合は、package-local test と影響する root-level check を更新してください。

## Rust 実装ルール

Rust は verifier / TEE などの決定的で監査しやすい処理に使う前提で実装してください。

- production logic では `unwrap` / `expect` / unchecked indexing を避ける。
- 失敗可能な処理は明示的な error として扱う。
- parse、validation、verification、serialization の段階を分離する。
- hash、Merkle root、BCS bytes、signature に影響する処理では、必ず決定的な順序を保つ。
- consensus や contract-facing data に影響する値では、float の曖昧さに注意する。必要に応じて正規化・整数化して扱う。
- serde struct は schemas / golden vector と整合させる。
- public API は小さく保ち、TypeScript 連携や test に必要なものだけを公開する。
- edge case、不正入力、golden vector compatibility のテストを追加する。
- 巧妙な抽象化より、レビューしやすい明快な実装を優先する。

Rust 変更後は、対象 crate の format / check / test を実行してください。

## Move 実装ルール

Move は最小権限を原則にしてください。

- まず private `fun` で実装する。
- package 内部で共有する処理には `public(package)` を使う。
- `public` / `entry` は、外部 API として意図した関数に限定する。
- `public(friend)` は使わない。
- `entry` は薄い入口にする。引数検証、権限確認、イベント発火、返り値制約の吸収に留め、コア状態遷移は private または `public(package)` に委譲する。
- 外部公開 API を内部実装モジュールに分散させない。
- accessors、admin、user entry など、外部から触る入口は専用モジュールへ寄せる。
- off-chain data は、contract 側で署名、status、version、payload constraints を検証できる場合のみ信頼する。
- object ownership、capability、admin authority は明示的に扱う。
- `#[test_only]` helper は使ってよいが、production API を test convenience に合わせて歪めない。

contract-visible behavior を変更する場合は、Move test を追加するか、追加できない理由を明記してください。

Move ファイル、`contracts/Move.toml`、`contracts/Move.lock` を変更した場合は、`pnpm check:move` を実行し、`sui move build` の warning / error を修正対象として扱ってください。Codex hooks は contracts 変更時にこの検証を自動実行します。

## ドキュメント方針

挙動、信頼境界、public API、schema semantics、environment variable、開発 workflow が変わる場合は docs を更新してください。

単に現在のフォルダ構成を説明するだけの docs 更新は避けてください。ドキュメントには、判断理由、設計意図、守るべき不変条件、運用上の前提を残してください。

bilingual 文書を編集する場合は、明示的な理由がない限り片方の言語だけを削除しないでください。

## テストと検証

検証コマンドは、root `package.json` と対象 package / crate / Move package の設定を確認して選んでください。

コード変更時は、まず対象範囲の狭いテストを実行し、その後に影響範囲を覆う check / typecheck / test を実行してください。

完了報告には、実行したコマンド、成功 / 失敗、実行していない重要な検証、既知の制限、follow-up が必要な項目を含めてください。実際に実行していない検証を「通った」と書かないでください。

## Git / PR ルール

commit message 作成や PR 準備では.agents/skills/draft-commit-message / .agents/skills/prepare-prを必ず使用してください。

issue 作成では `.agents/skills/prepare-issue` を必ず使用してください。新規実装や修正を実装する前に issue を起票し、その issue を `.agents/skills/gh-issue-implement` で実装する流れを基本にしてください。

## セキュリティとローカル設定

secret、API key、private credential、local MCP auth、個人用 Codex 設定、ローカルマシン固有の path、不要な生成物はコミットしないでください。

Sui / Walrus を使う開発では、repo 直下の `.local/sonari-dev/` を必ず使用してください。Sui wallet、keystore、Walrus client config、generated aliases、ローカル secret copy はこの配下に置き、infra や package-local な ad hoc path には新規作成しないでください。管理者 / publisher wallet は `.local/sonari-dev/sui_wallets/admin/`、SourceArchiver hot wallet は `.local/sonari-dev/sui_wallets/source-archiver/`、Walrus client config は `.local/sonari-dev/walrus/`、AWS secret copy は `.local/sonari-dev/aws-secrets/` に分離してください。

project-shared な Codex / agent 設定は、repository workflow として共有する意図が明確な場合のみコミットしてください。個人用 override は untracked のままにしてください。

## AWS テストと dev stack 確認

AWS 関連テストや dev stack 確認では、ad hoc AWS CLI command より `scripts/aws/README.md` の script を優先してください。runner を起動する script は cleanup 付きでなければ使わず、成功/失敗に関係なく ASG desired capacity `0`、ASG instance list empty、pending/running EC2 none、Watcher/Batch schedules `DISABLED` を確認してください。

SSM `--parameters commands=...` shorthand は使わないでください。multiline command は必ず JSON parameters file 経由にします。`SSM Online` は bootstrap 完了ではないため、`/opt/sonari/bootstrap-complete` などの marker を別 gate として確認してください。

## 依存関係

新しい dependency はデフォルトでは追加しないでください。まず standard library と既存 dependency で実装できないか検討してください。

dependency を追加する場合は、既存実装では不十分な理由、security / maintenance risk、package size や build への影響、runtime dependency か dev dependency かを説明してください。

## 失敗時の扱い

verifier、relayer、signing、submission、environment configuration では fail-closed を優先してください。

retry、queue、status transition は明示的に設計し、テストしてください。作業が永久に stuck する状態を作らないでください。
