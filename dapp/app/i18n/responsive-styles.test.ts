import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 狭い画面でのトップバー切替（issue #282）の退行を防ぐテスト。
// globals.css を文字列として読み、(1) ハンバーガーメニュー用のクラスが定義され
// 既定（広い画面）では隠れている、(2) 820px 以下で横並びナビを隠しメニューを出す、
// (3) 620px 以下でもウォレット接続ボタンを隠さない、を固定する。

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../globals.css"), "utf8");

/** `@media (max-width: Npx) { ... }` のブロック中身を波括弧の対応を数えて取り出す。 */
function mediaBlock(maxWidthPx: number): string {
    const head = `@media (max-width: ${maxWidthPx}px) {`;
    const start = css.indexOf(head);
    if (start < 0) {
        throw new Error(`media block ${maxWidthPx}px not found`);
    }
    let depth = 0;
    let i = start + head.length - 1; // 最初の '{' の位置
    const bodyStart = i + 1;
    for (; i < css.length; i++) {
        if (css[i] === "{") {
            depth++;
        } else if (css[i] === "}") {
            depth--;
            if (depth === 0) {
                return css.slice(bodyStart, i);
            }
        }
    }
    throw new Error(`media block ${maxWidthPx}px not closed`);
}

describe("ハンバーガーメニューのスタイル定義", () => {
    it("メニュー本体 .nav-menu と開閉ボタン .nav-menu-toggle を定義している", () => {
        expect(css).toMatch(/\.nav-menu\b/);
        expect(css).toMatch(/\.nav-menu-toggle\b/);
    });

    it("広い画面では .nav-menu を隠す（既定 display: none）", () => {
        expect(css).toMatch(/\.nav-menu\s*\{[^}]*display:\s*none/);
    });
});

describe("820px 以下のトップバー切替", () => {
    const block = mediaBlock(820);

    it("横並びナビ .nav を隠す", () => {
        expect(block).toMatch(/\.nav\s*\{[^}]*display:\s*none/);
    });

    it("ハンバーガーメニュー .nav-menu を表示する", () => {
        expect(block).toMatch(/\.nav-menu\s*\{[^}]*display:\s*(block|flex)/);
    });
});

describe("620px 以下でもウォレット接続を使える", () => {
    const block = mediaBlock(620);

    it("ウォレット接続ボタンを display: none で隠していない", () => {
        expect(block).not.toMatch(/wallet-connect/);
    });
});
