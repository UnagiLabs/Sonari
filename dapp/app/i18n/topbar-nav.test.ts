import { describe, expect, it } from "vitest";
import { DEFAULT_NAV_ITEMS, NAV_DEFS, resolveNavItems } from "./topbar-nav";

// トップバーの nav 構成を導く純粋関数のテスト。nav は全ページ共通の 4 項目に
// 統一したため（issue #330, #379）、resolveNavItems は常に同じ並びを返す。各項目の
// 遷移先（href）が固定であることもあわせて保証する。claim は受け取り導線を Mypage と
// 災害バナーへ寄せたため共通ナビからは外した（href 定義は深リンク用に残す）。

describe("resolveNavItems", () => {
    it("常に共通の 4 項目を順序どおり返す", () => {
        const items = resolveNavItems();
        expect(items.map((i) => i.key)).toEqual(["home", "donate", "dashboard", "register"]);
    });

    it("共通ナビに mypage と leaderboard を含めない", () => {
        const keys = resolveNavItems().map((i) => i.key);
        expect(keys).not.toContain("mypage");
        expect(keys).not.toContain("leaderboard");
    });

    it("各項目に NAV_DEFS の href を付与する", () => {
        const items = resolveNavItems();
        for (const item of items) {
            expect(item.href).toBe(NAV_DEFS[item.key].href);
        }
    });

    it("DEFAULT_NAV_ITEMS の並びをそのまま反映する", () => {
        const items = resolveNavItems();
        expect(items.map((i) => i.key)).toEqual([...DEFAULT_NAV_ITEMS]);
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
