---
name: gh-issue-implement
description: Implement a GitHub issue end to end in this repository using only Codex. Codex owns planning, plan review, implementation, verification, and PR creation. Use when the user gives a GitHub issue URL or asks to implement, fix, or work on a GitHub issue.
---

# gh-issue-implement

GitHub issue を **Codex だけで完結**させる repo-local workflow。

## 役割分担

- Codex:
  - issue 取得
  - 実装計画の立案
  - 計画監査
  - 実装、テスト、コミット、push、PR 作成、worktree cleanup
  - 最終レビュー

## 関連サーフェス

- subagents:
  - `issue_planner`
  - `plan_reviewer`
  - `issue_step_worker`
  - `verification_reviewer`
- scripts:
  - `.codex/hooks/manage-worktree.sh`
- references:
  - `references/step-design.md`
  - `references/workflow-checklist.md`
- supporting skills:
  - `$draft-commit-message`
  - `$prepare-pr`
  - `$code-review`

## 前提

- `gh` CLI が認証済み
- root `AGENTS.md` の repository instructions を守る

## 計画書・PR 本文の文体方針

この方針は issue に書き込む「実装計画」と、`$prepare-pr` で作る PR 本文の両方に適用する。

- 読み手は「実装に関わらないチームメンバーや他部署の大人」を想定する
- 基準は **中学生でも読み通せるレベル** にする
- 専門用語を使う場合は、初見で伝わりにくい語に短い補足か日常の比喩を添える
- 1 文は原則 60 文字以内を目安にし、能動態で主語をはっきりさせる
- 目的、変更点、影響範囲の順で書く
- 箇条書きは 1 項目 1 事実に分ける
- 絵文字や過剰な装飾は使わない
- 比喩は必要なときだけ使い、説明を飾りすぎない

## 実行契約

入力:

- GitHub issue URL
- または `owner/repo` と issue 番号

フロー:

1. Codex が issue を取得
2. `issue_planner` で phase / step 計画を固める
3. `plan_reviewer` が別コンテキストで計画監査する
4. blocking 指摘を反映後、ユーザー承認を 1 回だけ取る
5. 承認済み計画を issue 本文へ追記する
6. worktree を作り、`issue_step_worker` で step 単位に実装する
7. 各 step は完了直後に **その step 専用の 1 commit** を作る
8. ローカル検証を実行
9. `verification_reviewer` を fresh context で起動し、`$code-review` rubric で最終レビューする
10. blocking 指摘を修正し、必要なら再検証する
11. `$prepare-pr` の規約で PR を作成する
12. worktree と作業ブランチを cleanup する
13. cleanup 完了を確認してからユーザーへ完了報告する

## Preflight

実装前に必ず確認する:

```bash
gh --version
gh auth status -h github.com
git status --short --branch
```

`gh` が使えない、または認証されていない場合は続行しない。

## Phase 0: Issue 取得

issue 情報は GitHub app か `gh` CLI で取得する。CLI を使う場合:

```bash
gh issue view <number> --repo <owner>/<repo> --json title,body,labels,assignees,url
```

取得後に短く整理する:

- 目的
- 完了条件
- スコープ外
- 不明点

### 事前準備: `references_path` の算出

スキル起動時のベースディレクトリを基に、`<skill-dir>/references/step-design.md` を `references_path` として保持する。

以降の計画立案と実装では、この絶対パスを planner / worker へ渡して共通フォーマットの基準にする。

## Phase 1: Codex 計画立案

計画は **phase -> step** の 2 層で作る。詳細な判断基準と issue へ書き戻す計画書フォーマットは `references/step-design.md` を使う。

要件:

- TDD 前提で分割する
- フェーズ数は最大 3
- 各 step に完了条件を付ける
- ローカル検証の範囲を明記する
- PR-ready の判定条件を含める

`issue_planner` へ渡す入力:

- issue URL
- issue タイトル
- issue 本文
- `references_path`
- この SKILL.md の「計画書・PR 本文の文体方針」

計画は一時ファイルに書き出し、`plan_reviewer` へ渡す。

計画監査ルール:

- `plan_reviewer` は read-only の fresh context で計画だけを **1 回** レビューする
- 返却カテゴリは `blocking` と `advice` の 2 つに絞る
- `blocking` があれば Codex が計画へ反映する
- 反映後は原則として再監査しない
- phase 構成、step 分割、検証方針が大きく変わった場合のみ、例外として **1 回だけ** 再監査してよい
- `advice` は必要なものだけ計画本文か実装メモへ反映する

## Phase 2: ユーザー承認

Codex は計画監査結果を 2 から 4 行に圧縮して添え、ユーザーに **1 回だけ** 承認を求める。

修正要望があれば、`issue_planner` を再実行して計画を更新する。

## Phase 3: issue への計画書き込み

承認後、計画を issue 本文に追記する。

```bash
gh issue edit <number> --repo <owner>/<repo> --body "<original_body>

---

## 実装計画

<plan_content>"
```

追記する計画本文は `references/step-design.md` の issue 計画フォーマットに準拠させる。

## Phase 4: Worktree 作成

`.codex/state/worktrees` を使う。

```bash
.codex/hooks/manage-worktree.sh create <issue-number> <slug>
```

作成された worktree で実装する。依存が未インストールなら、その worktree で必要な package manager install を行う。

## Phase 5: Codex 実装

実装は **フェーズ -> step** の順で進める。フェーズ数が複数ある場合は、各フェーズが意味のある塊になっていることを保つ。

各 step では `issue_step_worker` に次を渡す:

- step 番号
- step タイトル
- step 目標
- step 完了条件
- 所属フェーズ番号・タイトル
- 計画全体
- `references_path`

各 step で行うこと:

1. 失敗するテストを追加または更新
2. 失敗を確認
3. 最小実装で通す
4. リファクタしてテスト再実行
5. step 完了条件を満たしたことを確認
6. その step の変更だけを commit して worktree を clean に戻す

step 完了の定義:

- **1 step = 1 commit**。例外なく守る
- 次の step に進む前に `git status --short` が空であることを確認する
- 複数 step の変更をまとめて 1 commit にしてはならない
- step の変更が独立して commit できない計画は粒度が大きすぎるため、計画を分割し直す
- **すべての commit message は `.agents/skills/draft-commit-message` を必ず使って作る**
- Codex が commit message を手書きしてはならない

コミットメッセージは `$draft-commit-message` の規約に従う。

各 step 完了時には、フェーズ番号と step 番号が分かる形で進捗を短く共有する。自動 checkpoint は増やさない。

## Phase 6: ローカル検証

変更に応じて対象 workspace を特定し、利用可能な script を実行する。Node workspace では少なくとも次を優先する:

```bash
npm run check
npm run typecheck
npm test
```

変更が広い場合や runtime/build 影響がある場合は `npm run build` まで実行する。

## Phase 7: Read-only 最終レビュー

ローカル検証後、`verification_reviewer` を **fresh context の read-only subagent** として起動し、`$code-review` を明示的に使わせて **PR 前ゲートレビュー** を行う。

レビュー context には少なくとも次を含める:

- issue 要約
- 実装サマリー
- ローカル検証結果
- 変更ファイル一覧
- `git diff --stat <base>...HEAD`

最終レビューのルール:

- 出力は `Verdict`、`Blocking findings`、`Residual risk`、`Validation gaps` の 4 項目に絞る
- `Blocking findings` は `blocking` / `high` 相当だけを最大 3 件まで返す
- 指摘がない場合は `No blocking findings` を明示し、2 から 3 行で終える
- `blocking` 指摘は必ず修正する
- 修正後は影響範囲のローカル検証をやり直す
- 修正が広範囲に波及した場合のみ、例外として `verification_reviewer` を 1 回だけ再実行してよい
- `blocking` が解消できない場合は PR を作らず停止する

## Phase 8: PR 作成

最終レビューが通ったら Codex が PR を作成する。

- push は Codex が行う
- PR の宛先ブランチは常に `main` にする
- PR タイトルと本文は `$prepare-pr` の規約に従い、この SKILL.md の「計画書・PR 本文の文体方針」も守る
- issue を必ず関連付ける
- テスト結果を本文に含める
- PR 作成だけでは完了扱いにしない

## Phase 9: Worktree cleanup と完了報告

PR 作成後は、ユーザーへ完了報告する前に worktree を必ず片付ける。

cleanup 手順:

```bash
.codex/hooks/manage-worktree.sh remove <issue-number> <slug>
git worktree list
git branch --list "feature/issue-<issue-number>-<slug>"
```

ルール:

- `manage-worktree.sh remove` で対象 worktree を削除する
- `git worktree list` で対象 worktree が消えたことを確認する
- `git branch --list` で対応する作業ブランチが残っていないことを確認する
- cleanup 完了後にのみ、PR URL を含む完了報告を行う
- cleanup が終わる前に「完了」「終わった」などの最終報告をしてはならない

cleanup で詰まりやすい例:

- worktree 内に未コミット変更や未追跡ファイルが残っている
- 別シェルや別プロセスがその worktree を使っている
- 対応ブランチを別 worktree が参照している
- `.git/worktrees/...` の管理情報が壊れている

## 停止条件

以下は即時停止する:

- `gh` 認証失敗
- 必須のローカル check が失敗し、解消できない
- `plan_reviewer` の `blocking` 指摘が未解消
- `verification_reviewer` の `blocking` 指摘が未解消
- PR 作成後の worktree cleanup が完了しない

## 重要事項

- `plan_reviewer` と `verification_reviewer` はどちらも read-only で使う
- 計画監査と最終レビューは、それぞれ fresh context の subagent で実行する
- 最終レビューは **必ず `$code-review` を明示利用**した短い gate review として行う
- 既存の未関連変更は巻き戻さない
- `issue_planner` / `plan_reviewer` / `issue_step_worker` / `verification_reviewer` の役割をまたいで責務を混ぜない
- 実装オーケストレーターは複数 step の変更を溜めてからまとめて commit してはならない
- 各 step の終了条件には「専用 commit が 1 つ作られ、worktree が clean」が含まれる
- step commit、review 対応 commit、finalizer commit を含む **すべての commit** で `$draft-commit-message` を先に使う
- issue 本文へ計画を書き戻してから worktree に入る
- PR 作成前に worktree と元の作業ツリーの状態を混同しない
- PR 作成後の worktree cleanup は省略不可
- cleanup 完了確認前にユーザーへ最終完了報告をしてはならない
