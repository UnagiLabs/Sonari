#!/usr/bin/env bash
# PreToolUse(Bash) hook（settings.json の `if: Bash(gh pr create*)` で PR 作成直前のみ発火）。
# ブランチ全体の品質ゲートを1回だけ走らせる。失敗したら exit 2 で PR 作成を中断する。
# コミットごとには走らせない（commit-auto のトークン消費とリトライ往復を避けるため）。
set -u

root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "${root:-}" ] || exit 0
cd "$root" || exit 0

fail=0
failed=""

# TS / Rust はブランチ全体を常にチェック（check:ts + check:rust）
pnpm check || { fail=1; failed="$failed check"; }

# Move は重いので、ブランチに Move 変更が含まれる場合のみ走らせる
base="$(git merge-base HEAD origin/main 2>/dev/null || true)"
if [ -n "${base:-}" ] && git diff --name-only "$base"...HEAD | grep -qE 'contracts/.*\.move$|contracts/Move\.(toml|lock)$'; then
  pnpm check:move || { fail=1; failed="$failed check:move"; }
fi

if [ "$fail" -ne 0 ]; then
  echo "Sonari pre-PR quality gate failed:$failed — branch is not green. Fix before opening the PR." >&2
  exit 2
fi
exit 0
