import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// マイページの画面が使う CSS クラスが、共通スタイル表 globals.css に
// すべて定義されていることを固定するテスト。クラスの付け忘れや削除で
// マイページだけ未スタイル表示になる退行を防ぐ（issue #277）。

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../globals.css"), "utf8");
const view = readFileSync(resolve(here, "mypage-view.tsx"), "utf8");
const map = readFileSync(resolve(here, "home-cell-map.tsx"), "utf8");

/** JSX の className="..." に書かれた静的なクラス名をすべて取り出す。 */
function classTokens(source: string): string[] {
    const out: string[] = [];
    const re = /className="([^"]+)"/g;
    let m: RegExpExecArray | null = re.exec(source);
    while (m !== null) {
        for (const token of m[1].split(/\s+/)) {
            if (token.length > 0) {
                out.push(token);
            }
        }
        m = re.exec(source);
    }
    return out;
}

/** `.name` がクラスセレクタとして定義されているか（直後が単語境界）。 */
function hasSelector(name: string): boolean {
    return new RegExp(`\\.${name}(?![\\w-])`).test(css);
}

const mypageTokens = [
    ...new Set([...classTokens(view), ...classTokens(map)].filter((t) => t.startsWith("mypage"))),
];

describe("mypage が使う CSS クラスは globals.css に定義されている", () => {
    it("mypage* クラスが 1 つ以上抽出できる（テストの健全性）", () => {
        expect(mypageTokens.length).toBeGreaterThan(0);
    });

    it.each(mypageTokens)("`.%s` が globals.css に定義されている", (token) => {
        expect(hasSelector(token)).toBe(true);
    });

    it("未定義の `button` クラスを使っていない", () => {
        expect(classTokens(view)).not.toContain("button");
        expect(classTokens(map)).not.toContain("button");
    });

    it("CTA / Retry ボタンが共通の btn btn-primary を使う", () => {
        expect(view).toContain('className="btn btn-primary"');
    });
});
