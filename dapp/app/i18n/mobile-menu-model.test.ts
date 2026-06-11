import { describe, expect, it } from "vitest";
import { buildMobileMenuItems } from "./mobile-menu-model";
import type { NavKey } from "./topbar-nav";
import { resolveNavItems } from "./topbar-nav";

// ハンバーガーメニューの表示モデルを組み立てる純粋関数のテスト（issue #282）。
// 渡した nav 項目を漏れなくリンク化し、現在ページにだけ active クラスを付け、
// 翻訳済みラベルを正しく対応づけることを固定する。

const navLabels: Readonly<Record<NavKey, string>> = {
    home: "ホーム",
    donate: "寄付",
    dashboard: "ダッシュボード",
    leaderboard: "リーダーボード",
    register: "登録",
    claim: "申請",
    mypage: "マイページ",
};

describe("buildMobileMenuItems", () => {
    it("渡した nav 項目をすべて同じ順序でリンク化する", () => {
        const items = resolveNavItems();
        const model = buildMobileMenuItems(items, "home", navLabels);
        expect(model.map((m) => m.key)).toEqual(items.map((i) => i.key));
        expect(model.map((m) => m.href)).toEqual(items.map((i) => i.href));
    });

    it("各項目に翻訳済みラベルを対応づける", () => {
        const model = buildMobileMenuItems(resolveNavItems(), "home", navLabels);
        for (const item of model) {
            expect(item.label).toBe(navLabels[item.key]);
        }
    });

    it("現在ページにだけ active クラスを付ける", () => {
        const model = buildMobileMenuItems(resolveNavItems(), "donate", navLabels);
        const donate = model.find((m) => m.key === "donate");
        const home = model.find((m) => m.key === "home");
        expect(donate?.className).toBe("nav-item active");
        expect(home?.className).toBe("nav-item");
    });

    it("渡した items の並びだけを対象にする（既定 6 項目）", () => {
        const model = buildMobileMenuItems(resolveNavItems(["home", "claim"]), "claim", navLabels);
        expect(model.map((m) => m.key)).toEqual(["home", "claim"]);
        expect(model.find((m) => m.key === "claim")?.className).toBe("nav-item active");
    });
});
