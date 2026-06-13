import { describe, expect, it } from "vitest";
import { NAV_DEFS, resolveNavItems } from "./topbar-nav";

// トップバーの nav 構成を導く純粋関数のテスト。ページごとに異なる表示項目
// （既定 5 項目 / register 5 項目 / mypage 3 項目）を items 指定で再現できること、
// 各項目の遷移先（href）が固定であることを保証する。

describe("resolveNavItems", () => {
    it("items 省略時は既定の 5 項目を順序どおり返す", () => {
        const items = resolveNavItems();
        expect(items.map((i) => i.key)).toEqual([
            "home",
            "donate",
            "dashboard",
            "register",
            "claim",
        ]);
        expect(items.map((i) => i.key)).not.toContain("leaderboard");
    });

    it("register 用の 5 項目（leaderboard なし）を再現できる", () => {
        const items = resolveNavItems(["home", "donate", "dashboard", "register", "claim"]);
        expect(items.map((i) => i.key)).toEqual([
            "home",
            "donate",
            "dashboard",
            "register",
            "claim",
        ]);
        expect(items.map((i) => i.key)).not.toContain("leaderboard");
    });

    it("mypage 用の 3 項目を再現でき mypage の href は /mypage", () => {
        const items = resolveNavItems(["home", "register", "mypage"]);
        expect(items.map((i) => i.key)).toEqual(["home", "register", "mypage"]);
        const mypage = items.find((i) => i.key === "mypage");
        expect(mypage?.href).toBe("/mypage");
    });

    it("各項目に NAV_DEFS の href を付与する", () => {
        const items = resolveNavItems(["home", "claim"]);
        expect(items).toEqual([
            { key: "home", href: "/" },
            { key: "claim", href: "/claim" },
        ]);
    });
});

describe("NAV_DEFS", () => {
    it("既知の全 NavKey に href を定義している", () => {
        expect(NAV_DEFS.home.href).toBe("/");
        expect(NAV_DEFS.donate.href).toBe("/donate");
        expect(NAV_DEFS.dashboard.href).toBe("/dashboard");
        expect(NAV_DEFS.register.href).toBe("/register");
        expect(NAV_DEFS.claim.href).toBe("/claim");
        expect(NAV_DEFS.mypage.href).toBe("/mypage");
        expect(NAV_DEFS).not.toHaveProperty("leaderboard");
    });
});
