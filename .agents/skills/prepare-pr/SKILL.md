---
name: prepare-pr
description: Prepare and create a pull request using the repository's PR conventions. Use when the user asks to open a PR, prepare PR title and body, or summarize the current branch for review.
---

# prepare-pr

現在のブランチから PR を作る。

## Preflight

1. `git status --short --branch`
2. `git rev-parse --abbrev-ref HEAD`
3. `git fetch origin`
4. `gh --version`
5. `gh auth status -h github.com`

ベースブランチが明示されていない場合は、mainとし､指定ある場合はそのブランチへ向けたPRを作成する｡

## 差分確認

```bash
git log --oneline <base-branch>..HEAD
git diff --stat <base-branch>...HEAD
git diff <base-branch>...HEAD
```

必要なら push:

```bash
git push -u origin HEAD
```

PR 作成:

```bash
gh pr create --base <base-branch> --title "<title>" --body-file <tmp-file>
```

## タイトル形式

```text
type: 具体的な変更内容を要約したタイトル
```

`type`:

- `feat`
- `fix`
- `docs`
- `refactor`
- `test`
- `other`

## 本文構成

```markdown
## 概要
変更の目的や背景、解決する課題

## 変更内容
- `ファイルパス`
  - 変更点

## 関連する Issue やチケット
Close #123

## 動作確認
必要に応じて
```

## ルール

- `🤖 Generated with ...` のような署名を付けない
- `Co-Authored-By` を付けない
- `main` 向け PR では、その PR に直接関係する Issue だけを書く

## 完了確認

PR 作成後に次を確認する:

```bash
gh pr view --json url,title,baseRefName,headRefName
```
