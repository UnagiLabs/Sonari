---
name: implement-codex-plan
description: Faithfully implement a pre-made implementation plan that Claude generated with issue-to-codex-plan and saved to .codex/prompts/issue-<number>.md. Use this when an implementation plan already exists and only needs to be implemented — Codex does NOT plan, audit, or seek plan approval here. Prefer this over gh-issue-implement whenever the user points to an existing plan file, pasted plan, or says the plan is already decided and just needs implementing.
---

# implement-codex-plan

確定済みの実装計画を **Codex が忠実に実装する** ための repo-local workflow。

計画は Claude 側の `issue-to-codex-plan` が作り、`.codex/prompts/issue-<番号>.md` に保存されている。
このスキルは **計画を立てない**。計画は「実装の契約」として扱い、その通りに実装・検証・PR まで進める。

## このスキルの境界（最重要）

- 計画フェーズは行わない。`issue_planner` も `plan_reviewer` も使わない。
- 計画の再立案、計画監査、計画のユーザー承認ゲート、issue 本文への計画書き戻しは行わない。
- `gh-issue-implement` を呼ばない。計画が既にあるこのフローでは `gh-issue-implement` ではなく本スキルを使う。
- 計画は受け取った内容を尊重する。勝手にスコープを広げない、勝手に縮めない。
- 唯一の判断ポイントは「計画とコードの実態が食い違ったとき」だけ（後述の停止条件）。

## 役割分担

- Codex:
  - 計画ファイルの読み込みと健全性チェック
  - worktree 作成
  - 計画通りの実装、テスト、コミット
  - ローカル検証
  - clean-context `/review` による PR 前ゲート
  - PR 作成、worktree cleanup、完了報告

## 関連サーフェス

- subagents:
  - `issue_step_worker`
  - clean-context `/review` subagent
- references:
  - `references/workflow-checklist.md`
- supporting skills:
  - `$draft-commit-message`
  - `$prepare-pr`

## 前提

- `gh` CLI が認証済み
- 実装する計画ファイルが存在する（既定は `.codex/prompts/issue-<番号>.md`）
- root `AGENTS.md` の repository instructions を守る

## 実行契約

入力（いずれか）:

- issue 番号（既定。`.codex/prompts/issue-<番号>.md` を計画として読む）
- 計画ファイルのパス（明示指定された場合）
- 貼り付けられた計画本文（ファイルが無い場合のフォールバック）

フロー:

1. 計画ファイルを特定して読み込む
2. 計画から issue 番号・ゴール・スコープ・検証コマンドを把握する
3. worktree を作る
4. 計画通りに step 単位で実装する（1 step = 1 commit）
5. ローカル検証を実行する
6. clean-context のサブエージェントに Codex CLI 標準の `/review` を実行させる
7. `$prepare-pr` の規約で PR を作成する
8. worktree と作業ブランチを cleanup する
9. cleanup 完了を確認してからユーザーへ完了報告する

## Preflight

実装前に必ず確認する:

```bash
gh --version
gh auth status -h github.com
git status --short --branch
```

`gh` が使えない、または認証されていない場合は続行しない。

## Phase 0: 計画の読み込みと健全性チェック

### 0-1. 計画ファイルの特定

優先順位:

1. ユーザーが計画ファイルのパスを明示した場合は、そのパスを使う。
2. issue 番号が分かる場合は `.codex/prompts/issue-<番号>.md` を読む。
3. 上記いずれも無く、ユーザーが計画本文を貼り付けた場合は、その本文を計画として扱う。
4. 計画ファイルもパスも貼り付けも無い場合は実装しない。`issue-to-codex-plan` で計画を作るか、計画ファイルのパスを渡すようユーザーに案内して停止する。

```bash
# 既定パスの存在確認（issue 番号が分かっている場合）
ls -l .codex/prompts/issue-<番号>.md
```

### 0-2. 計画の把握

計画ファイルから次を読み取り、短く自分の言葉で整理する:

- 対象 issue 番号（計画冒頭の `GitHub issue #<番号>` から抽出）
- ゴールと完了条件
- ユーザー確定済みの設計判断
- 許可スコープとスコープ外
- 最初に確認すべきファイル・シンボル
- 検証コマンド
- 最終報告フォーマット

計画が `issue-to-codex-plan` のテンプレート構成で書かれている場合は、その見出し（`ゴール` / `ユーザー確定済みの設計判断` / `許可スコープ` / `スコープ外` / `検証コマンド` / `完了条件`）を優先して読む。

### 0-3. 計画とコードの食い違いチェック（軽量）

広範な編集を始める前に、計画の「最初に確認するファイル」と主要シンボルだけを軽く確認し、計画が現在のコードベースと整合しているか確かめる。

- 整合している、または軽微な差異なら、そのまま実装に進む。
- **計画とコードの実態が本質的に矛盾する場合は、広範な編集を始める前に停止し、矛盾をユーザーに報告して判断を仰ぐ**（停止条件を参照）。
- ここでは計画を作り直さない。修正が要る場合は `issue-to-codex-plan` での計画更新をユーザーに促す。

## Phase 1: Worktree 作成

標準の `git worktree` を使い、worktree は `.codex/state/worktrees` 配下に作る。
**計画本文に別の worktree パス（例: 親ディレクトリの sibling）指定があっても、本スキルのこの規約を優先して上書きする。** worktree の場所以外の計画内容は忠実に従う。

```bash
mkdir -p .codex/state/worktrees
git fetch origin main
git worktree add -b feature/issue-<番号>-<slug> .codex/state/worktrees/issue-<番号>-<slug> origin/main
git -C .codex/state/worktrees/issue-<番号>-<slug> status --short --branch
```

- ブランチ名は計画やリポジトリの命名規則に従う。規則が無ければ `feature/issue-<番号>-<slug>` とする。
- worktree path または branch が既に存在する場合は、上書きせず停止して状況を報告する。
- 以降のすべての作業（実装・テスト・コミット）はこの worktree 内でのみ行い、元の作業ツリーには一切変更を加えない。
- 依存が未インストールなら、その worktree で必要な package manager install を行う。

## Phase 2: 忠実な実装

計画の「実装手順」「実装計画」のステップ順に進める。計画にステップ分割がある場合はそれに従い、無い場合は計画のゴールから意味のある最小ステップに自分で割る。

進め方の原則:

- 計画に書かれたスコープ内のファイルだけを変更する。無関係なリファクタ、一括フォーマット、依存アップグレード、アーキテクチャ刷新はしない。
- 計画の「ユーザー確定済みの設計判断」に厳密に従う。
- 既存のパターン、ユーティリティ、規約を優先する。
- 設計判断で明示的に許可されていない限り、新しい本番依存を追加しない。

実装の進め方（fast path / worker）:

- 1 step / 低リスクの小規模変更で高リスク surface に触れない場合は、Codex 本体が直接 TDD 実装してよい。
- 複数 step、複数レイヤー、高リスク変更、または worker 分離が有効な場合は `issue_step_worker` を使う。
- 高リスク surface には schema、BCS、signature、Merkle root、Move contract、trust boundary、auth、secret、AWS 実行系を含む。

`issue_step_worker` を使う場合は次を渡す:

- step 番号
- step タイトル
- step 目標
- step 完了条件
- 計画全体（または該当箇所）

各 step で行うこと（TDD）:

1. 変更前に失敗するテストを追加または更新
2. 失敗を確認
3. 最小実装で通す
4. リファクタしてテスト再実行
5. step 完了条件を満たしたことを確認
6. その step の変更だけを commit して worktree を clean に戻す

step 完了の定義（1 step = 1 commit、例外なく厳守）:

- **1 step = 1 commit**。複数 step の変更をまとめて 1 commit にしてはならない。
- 次の step に進む前に `git status --short` が空であることを確認する。
- step の変更が独立して commit できない場合は粒度が大きすぎる。step を分割し直す。
- **すべての commit message は `$draft-commit-message` を必ず使って作る。** Codex が commit message を手書きしてはならない。
- 各 step 完了時に、どの step を終えたか短く進捗共有する。自動 checkpoint は増やさない。

実装中に計画とコードが本質的に矛盾した場合は、その時点で停止してユーザーに報告する（停止条件を参照）。勝手に計画を作り直さない。

## Phase 3: ローカル検証

まず計画の「検証コマンド」を実行する。加えて、変更に応じて対象 workspace を特定し、root `package.json` と対象 package / crate / Move package の設定から利用可能な script を実行する。

Sonari の標準例:

```bash
pnpm check
# 必要に応じて対象テストを追加する
pnpm --filter <workspace> test
```

Move ファイル、`contracts/Move.toml`、`contracts/Move.lock` を変更した場合は次も実行する:

```bash
pnpm check:move
```

- `pnpm check` は typecheck を含むため、`pnpm typecheck` を重複実行しない。
- 変更が広い場合、CI 相当の確認が必要な場合、runtime/build 影響がある場合は `pnpm test` や該当 build script を追加する。
- 計画の検証コマンドが実行できない場合は、その理由を正確に説明し、最も近い安全な代替を実行する。

## Phase 4: clean-context `/review` 最終レビュー

ローカル検証後、クリーンなコンテキストのサブエージェントを起動し、Codex CLI 標準の `/review` コマンドで **PR 前ゲートレビュー** を行わせる。

`/review` は PR 方式で、実装ブランチと `main` を比較する形で実行する。作業ツリー差分だけを対象にしてはならない。

`/review` サブエージェントへ渡す context には少なくとも次を含める:

- 計画のゴール要約
- 実装サマリー
- ローカル検証結果
- 変更ファイル一覧
- current branch name
- base branch は `main`
- `git diff --stat main...HEAD`

最終レビューのルール:

- `/review` の結果を PR 前ゲートとして扱う。
- 通常は clean-context `/review` を 1 回だけ実行する。
- PR 作成を止めるのは `blocking` または high-confidence の correctness / security / regression 指摘だけにする。
- advice、nit、low-confidence 指摘は、直さない場合 PR 本文の follow-up または検証ギャップに記載する。
- 指摘を修正した後は、影響範囲のローカル検証をやり直す。
- 再レビューは最大 1 回まで。schema、BCS、signature、Merkle root、Move contract、trust boundary、auth、secret、AWS 実行系の変更、または blocking 修正が大きい場合だけ実行する。
- blocking 指摘が解消できない場合は PR を作らず停止する。

## Phase 5: PR 作成

最終レビューが通ったら Codex が PR を作成する。

- push は Codex が行う。
- PR の宛先ブランチは常に `main` にする。
- PR タイトルと本文は `$prepare-pr` を必ず使用して作成する。
- 対象 issue を必ず関連付ける。
- 計画の完了条件に対する結果と、実行したテスト・検証結果を本文に含める。
- PR 作成だけでは完了扱いにしない。

## Phase 6: Worktree cleanup と完了報告

PR 作成後は、ユーザーへ完了報告する前に worktree を必ず片付ける。

```bash
git -C .codex/state/worktrees/issue-<番号>-<slug> status --short
git worktree remove .codex/state/worktrees/issue-<番号>-<slug>
git branch -d feature/issue-<番号>-<slug>
git worktree list
git branch --list "feature/issue-<番号>-<slug>"
```

ルール:

- `git -C <worktree-path> status --short` が空であることを確認してから削除する。
- `git worktree remove <worktree-path>` で対象 worktree を削除する。
- `git branch -d feature/issue-<番号>-<slug>` で local branch を削除する。
- `git worktree list` で対象 worktree が消えたことを確認する。
- `git branch --list` で対応する作業ブランチが残っていないことを確認する。
- remote branch は PR 用に残し、削除対象は local worktree と local branch に限定する。
- worktree に未コミット変更や未追跡ファイルがある場合は、`git worktree remove --force` を使わず停止する。
- `git branch -d` が未マージ判定で失敗した場合は、`git branch -D` を使わず停止する。
- cleanup 完了後にのみ、PR URL を含む完了報告を行う。
- cleanup が終わる前に「完了」「終わった」などの最終報告をしてはならない。

完了報告には、計画の最終報告フォーマットがあればそれに従い、次を含める:

1. 変更内容の要約
2. 変更ファイルの一覧
3. 実行したテスト・チェックとその結果
4. PR の URL とブランチ名
5. リスク、フォローアップ、実行できなかったコマンド

## 停止条件

以下は即時停止し、状況をユーザーに報告する:

- 計画ファイルが特定できない（パス・issue 番号・貼り付けのいずれも無い）。
- `gh` 認証失敗。
- **計画とコードの実態が本質的に矛盾する。** 広範な編集を始める前に停止し、矛盾点・該当ファイル・計画との差分・実装を止めた理由・確認したい判断を報告する。ユーザーが明示的に「その差異のまま進める」と指示した場合だけ続行し、その場合も PR 本文に矛盾のまま進めたことを明記する。
- 必須のローカル check が失敗し、解消できない。
- `/review` の blocking 指摘が未解消。
- PR 作成後の worktree cleanup が完了しない。

## やってはいけないこと

- 計画を作り直す、計画監査する、計画のユーザー承認を取る、計画を issue 本文へ書き戻す。
- `issue_planner` / `plan_reviewer` / `gh-issue-implement` を呼ぶ。
- 計画に無いスコープへ勝手に広げる、または計画のスコープを勝手に縮める。
- 複数 step の変更を溜めてからまとめて commit する。
- commit message を手書きする（必ず `$draft-commit-message`）。
- 既存の未関連変更を巻き戻す。
- 直接必要でない限り、生成ファイル・lockfile・マイグレーション・スナップショットを変更する。
- mainへの直接 push、PR のマージ、デプロイ。
- worktree cleanup 完了確認前に最終完了報告をする。
