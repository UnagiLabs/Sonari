import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 狭い画面でのトップバー切替（issue #282）と、モバイルヘッダー/緊急バナー刷新の
// 退行を防ぐテスト。globals.css を文字列として読み、(1) ハンバーガーメニュー用の
// クラスが定義され既定（広い画面）では隠れている、(2) 820px 以下で横並びナビを隠し
// メニューを出しつつデスクトップ右クラスタをモバイルクラスタに差し替える、
// (3) 620px 以下でもウォレット接続ボタンを隠さない、(4) 820px 以下で緊急バナーを
// コンパクトカード（mini マグニチュード + 災害名）に作り替える、を固定する。

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../globals.css"), "utf8");

/**
 * `@media (max-width: Npx) {` の start 位置から、波括弧の対応を数えてブロック中身を返す。
 */
function readBlockBody(start: number, label: string): string {
    let depth = 0;
    let i = css.indexOf("{", start); // 最初の '{' の位置
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
    throw new Error(`media block ${label} not closed`);
}

/** 同じ条件のブロックが複数あるため、最初に見つかった `@media (max-width: Npx)` を返す。 */
function mediaBlock(maxWidthPx: number): string {
    const head = `@media (max-width: ${maxWidthPx}px) {`;
    const start = css.indexOf(head);
    if (start < 0) {
        throw new Error(`media block ${maxWidthPx}px not found`);
    }
    return readBlockBody(start, `${maxWidthPx}px`);
}

/**
 * 同じ条件の `@media (max-width: Npx)` ブロックが複数あるため、本文に marker を含む
 * 最初のブロックを返す。occurrence 番号に依存せず、対象ブロックを安定して特定する。
 */
function mediaBlockWith(maxWidthPx: number, marker: string): string {
    const head = `@media (max-width: ${maxWidthPx}px) {`;
    let searchFrom = 0;
    for (;;) {
        const start = css.indexOf(head, searchFrom);
        if (start < 0) {
            throw new Error(`media block ${maxWidthPx}px containing "${marker}" not found`);
        }
        const body = readBlockBody(start, `${maxWidthPx}px`);
        if (body.includes(marker)) {
            return body;
        }
        searchFrom = start + head.length;
    }
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

    it("デスクトップ右クラスタ .topbar-actions を隠す", () => {
        expect(block).toMatch(/\.topbar-actions\s*\{[^}]*display:\s*none/);
    });

    it("モバイルクラスタ .topbar-mobile-cluster を表示する", () => {
        expect(block).toMatch(/\.topbar-mobile-cluster\s*\{[^}]*display:\s*(inline-flex|flex)/);
    });
});

describe("620px 以下でもウォレット接続を使える", () => {
    const block = mediaBlock(620);

    it("ウォレット接続ボタンを display: none で隠していない", () => {
        expect(block).not.toMatch(/wallet-connect/);
    });
});

describe("820px 以下の緊急バナー モバイル刷新レイアウト", () => {
    // 820px ブロックは複数あるため、緊急バナーのクラスを含むブロックを marker で特定する。
    const block = mediaBlockWith(820, ".donate-emergency-banner");

    it("左レール 5px + 本体の2列に切り替える", () => {
        expect(block).toContain("grid-template-columns: 5px minmax(0, 1fr);");
    });

    it("デスクトップの大きなマグニチュードを畳む", () => {
        expect(block).toMatch(/\.donate-emergency-banner-magnitude\s*\{[^}]*display:\s*none/);
    });

    it("モバイル見出し行 .donate-emergency-banner-lead を表示する", () => {
        expect(block).toMatch(/\.donate-emergency-banner-lead\s*\{[^}]*display:\s*flex/);
    });

    it("汎用 title と本文をモバイルでは隠す", () => {
        expect(block).toMatch(/\.donate-emergency-banner-title[^{]*\{[^}]*display:\s*none/);
    });
});
