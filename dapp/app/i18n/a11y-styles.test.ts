import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// アクセシビリティのフォーカス可視化（issue #282）の退行を防ぐテスト。
// globals.css を文字列として読み、(1) 操作できる要素に :focus-visible リングが
// 定義されていること、(2) outline: none が代替スタイル付きの既知 2 箇所以外に
// 増えていないこと、を固定する。キーボード操作時にフォーカス位置が見えなくなる
// 退行を検知する。

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../globals.css"), "utf8");

describe("globals.css のフォーカス可視化スタイル", () => {
    it("フォーカスリング色のトークン --focus-ring を定義している", () => {
        expect(css).toMatch(/--focus-ring:/);
    });

    it("要素ベースの :focus-visible ルールでリングを付けている", () => {
        // a / button / summary / input などに :focus-visible が定義されていること。
        expect(css).toMatch(/:focus-visible/);
        // リングは outline で表現し、レイアウトを崩さない。
        const focusVisibleBlocks = css.match(/:focus-visible[^{]*\{[^}]*\}/g) ?? [];
        const hasOutlineRing = focusVisibleBlocks.some((block) =>
            /outline:\s*[^;]*var\(--focus-ring\)/.test(block),
        );
        expect(hasOutlineRing).toBe(true);
    });

    it("主要な操作要素を :focus-visible の対象セレクタに含む", () => {
        const focusVisibleSelectors = (css.match(/[^{}]*:focus-visible[^{]*\{/g) ?? []).join(" ");
        for (const element of ["a", "button", "summary"]) {
            expect(focusVisibleSelectors).toMatch(
                new RegExp(`(^|[^\\w-])${element}:focus-visible`),
            );
        }
    });
});

describe("outline: none は代替スタイル付きの既知 2 箇所のみ", () => {
    const outlineNoneCount = (css.match(/outline:\s*none/g) ?? []).length;

    it("outline: none の出現は 2 箇所だけ", () => {
        expect(outlineNoneCount).toBe(2);
    });

    it("amount-input-wrap input には :focus-within の代替リングがある", () => {
        expect(css).toMatch(/\.amount-input-wrap:focus-within\s*\{[^}]*box-shadow/);
    });

    it("text-field input/textarea には :focus の代替リングがある", () => {
        expect(css).toMatch(/\.text-field input:focus[^{]*\{[^}]*box-shadow|\.text-field[^{]*:focus[^{]*\{[^}]*box-shadow/);
    });
});
