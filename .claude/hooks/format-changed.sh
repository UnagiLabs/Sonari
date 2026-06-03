#!/usr/bin/env bash
# PostToolUse(Edit|Write|MultiEdit) hook.
# 変更された「その1ファイル」を、種類に応じて整形する。高速・非ブロッキング（常に exit 0）。
# typecheck / clippy / 全体 lint はコミット時ゲート(precommit-quality-gate.sh)で実施する。
set -u

input="$(cat)"
file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null || true)"
[ -n "${file:-}" ] || exit 0
[ -f "$file" ] || exit 0

# worktree でもファイル位置から正しいリポジトリ root を解決する
root="$(git -C "$(dirname "$file")" rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "${root:-}" ] || exit 0
cd "$root" || exit 0

case "$file" in
  *.rs)
    # cargo fmt は各クレートの edition(=2024) と workspace 設定を尊重する。
    # rustfmt 単体だと edition を取り違えるため cargo fmt を使う。--all で workspace 全体を整形
    # するが、コミット済みファイルは整形済みなので実際に変わるのは編集したファイルのみ。
    cargo fmt --all >/dev/null 2>&1 || true
    ;;
  *.move)
    # このリポジトリに Move 用フォーマッタは無い（check:move は build/lint/test で整形ではない）。
    # 整形対象が無いので何もしない。
    :
    ;;
  *)
    # TS/JS/JSON 等は Biome で整形する。Biome は files.includes 対象外（.yaml 等）は黙って無視する。
    # format のみ（lint 自動修正なし）にして多段編集中の import 並べ替え等の破壊を避ける。
    pnpm biome format --write "$file" >/dev/null 2>&1 || true
    ;;
esac
exit 0
