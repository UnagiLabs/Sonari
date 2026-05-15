# Repository Guidelines

## プロジェクト構成とモジュール

Sonari は Sui Overflow 2026 提出用のハッカソンプロジェクトです。このリポジトリは現時点ではドキュメント中心で、ユーザー向けの企画書、仕様書、説明資料は `docs/` に配置します。

- `docs/sonari_overview.html` - Sonari の概要ページ。
- `docs/defi_payments_problem_statement.md` - DeFi / Payments 課題文の bilingual 文書。
- `docs/nautilus_disaster_oracle/spec.html` - Nautilus Earthquake Oracle の要件定義ページ。
- `docs/tech_stack.md` と `docs/business_logic.md` - 今後の技術構成、事業ロジック整理用。

`.codex/` と `.agents/` はローカルの Codex / agent 設定です。現在は `.gitignore` 対象なので、共有方針が変わらない限りコミットしないでください。

## ビルド・テスト・開発コマンド

root `package.json` は pnpm workspace の集約コマンドを提供します。作業時は以下のコマンドを使います。

- `pnpm install` - TypeScript workspace 依存関係を解決します。
- `pnpm typecheck` - workspace package の TypeScript 型検証を実行します。
- `pnpm test` - TypeScript の unit test を実行します。
- `pnpm test:oracle` - Nautilus Oracle の TypeScript test と Rust TEE crate test をまとめて実行します。
- `cargo test --manifest-path nautilus_disaster_oracle/tee/Cargo.toml` - TEE crate 単体の Rust test を実行します。
- `python3 -m http.server 8000` - ルートから HTML を配信し、`http://localhost:8000/docs/...` で確認します。
- `git diff --check` - 末尾空白やパッチ形式の問題を検出します。
- `find docs -maxdepth 2 -type f` - 現在のドキュメント一覧を確認します。

今後 dApp や contracts のビルドシステムを追加した場合は、dev / build / deploy の正確なコマンドをこの節に追記してください。

## コーディングスタイルと命名規則

説明文書は Markdown、見栄えを含む仕様ページは単体 HTML/CSS を使います。HTML と CSS は既存ファイルに合わせて 2 スペースインデントを基本にしてください。ファイル名は小文字とアンダースコアを使い、例として `defi_payments_problem_statement.md` の形式に揃えます。

既存文書の多くは日本語と英語の併記です。bilingual 文書を編集する場合は、明示的な理由がない限り片方の言語だけを削除しないでください。

## テスト方針

自動テストは未設定です。ドキュメント変更では、対象 HTML をブラウザで開き、デスクトップ幅とモバイル幅の表示を確認してください。Markdown は見出し、箇条書き、日英併記の改行が意図通り表示されるか確認します。提出前に `git diff --check` を実行してください。

## MVP 開発方針

現在は MVP 作成段階であり、初期開発のため後方互換性は一切考慮不要です。Sonari の提出物として最適な設計、明確な責務分離、実装品質を最優先してください。必要であれば破壊的変更、ファイル構成の変更、仕様整理を積極的に行ってかまいません。ただし、変更理由と影響範囲は PR や作業メモで明確に説明してください。

## Move 可視性方針

Move 2024 の可視性は最小権限を原則とします。`public(friend)` は使わず、`fun` / `public(package)` / `public` / `entry` を次の基準で選んでください。

- まず `fun` で始めます。同一モジュール内だけで使う純ヘルパー、検証関数、ループ補助は private に閉じます。
- パッケージ内共有ロジックは `public(package)` を使います。イベント emit、mint ヘルパー、registry の内部更新、生成処理など、複数モジュールから使うが外部公開したくない関数が対象です。
- `public` / `entry` は公開 API モジュールに集約します。外部から触る関数は `accessors.move` や `admin.move` のような専用モジュールへ寄せ、内部実装モジュールに分散させないでください。
- `entry` は薄い入口にします。PTB から直接叩く関数は、引数受け取り、権限確認、イベント発火、返り値制約の吸収に留め、コア状態遷移は `public(package)` または private 関数へ委譲します。
- PTB から呼びたいが外部モジュール公開は不要な場合は `public(package) entry` を検討します。Sponsored Transaction の入口や管理者操作の薄いラッパに使えます。
- 返り値制約で `entry` にできない場合だけ `public fun` を使います。`Coin` など `drop` を持たない値を返す、PTB 内で他処理と合成したい、といった理由をコード上で説明できる状態にしてください。
- `#[test_only]` は本番 API と分けてよいです。テスト専用 accessor や生成関数は `#[test_only] public` / `#[test_only] public(package)` を使ってよいですが、本番コードから使う前提で設計しないでください。

## コミットと Pull Request

直近の履歴では `docs: Sonari概要HTMLにスタイルを統合` や `chore: gitignoreを追加` のように、短い conventional-style の prefix が使われています。基本形は `<type>: <summary>` とし、`type` には `docs`、`chore`、`fix` などを使います。

コミットメッセージを作成する場合は `.agents/skills/draft-commit-message` を使用し、現在の diff と直近履歴に基づく日本語メッセージを作成してください。実コミットはユーザーの明示がある場合のみ行います。

Pull Request を準備または作成する場合は `.agents/skills/prepare-pr` を使用してください。PR には変更概要、主な変更ファイル、表示に影響する HTML 変更のスクリーンショットを含めます。関連 issue やハッカソンタスクがあればリンクし、手動確認したブラウザチェックも記載します。

## セキュリティと設定

secret、API key、ローカル MCP 認証情報、個人用 Codex 設定はコミットしないでください。生成物やマシン固有の設定は、共有する明確な意図がある場合を除き、バージョン管理の外に置きます。
