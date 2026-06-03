#!/usr/bin/env bash
# PreToolUse(Bash) hook（settings.json の `if: Bash(git commit*)` で git commit 時のみ発火）。
# コミット前に1回だけ、ステージ済みファイルの種類に応じてスコープした品質ゲートを走らせる。
# 関連チェックが落ちたら exit 2 でコミットを中断する。
set -u

root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "${root:-}" ] || exit 0
cd "$root" || exit 0

changed="$(git diff --cached --name-only)"
[ -n "$changed" ] || exit 0   # ステージが空なら何もしない

fail=0
failed=""

if printf '%s\n' "$changed" | grep -qE '\.(ts|tsx)$|(^|/)package\.json$|(^|/)tsconfig[^/]*\.json$|(^|/)vitest\.config\.ts$|(^|/)biome\.jsonc?$|(^|/)pnpm-lock\.yaml$'; then
  pnpm check:ts || { fail=1; failed="$failed check:ts"; }
fi
if printf '%s\n' "$changed" | grep -qE '\.rs$|(^|/)Cargo\.(toml|lock)$'; then
  pnpm check:rust || { fail=1; failed="$failed check:rust"; }
fi
if printf '%s\n' "$changed" | grep -qE 'contracts/.*\.move$|contracts/Move\.(toml|lock)$'; then
  pnpm check:move || { fail=1; failed="$failed check:move"; }
fi

if [ "$fail" -ne 0 ]; then
  echo "Sonari pre-commit quality gate failed:$failed — staged changes are not green. Fix before committing." >&2
  exit 2
fi
exit 0
