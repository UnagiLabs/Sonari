// トップバーの nav 構成を 1 箇所に集約する。nav は全ページ共通の同じ並びに
// 統一したため（issue #330）、表示項目はページごとに絞らず DEFAULT_NAV_ITEMS を
// 正典として常に同じ並びを返す。文言は messages の topbar.nav.* カタログから引く
// ため、ここでは持たない。

export type NavKey = "home" | "donate" | "dashboard" | "register" | "claim" | "mypage";

/** 各 nav 項目の遷移先。キーと href の対応をここで一元管理する。 */
export const NAV_DEFS: Record<NavKey, { readonly href: string }> = {
    home: { href: "/" },
    donate: { href: "/donate" },
    dashboard: { href: "/dashboard" },
    register: { href: "/register" },
    claim: { href: "/claim" },
    mypage: { href: "/mypage" },
};

/**
 * 全ページ共通のプライマリ nav。home / donate / dashboard / register / claim の
 * 5 項目を正典として持つ。mypage はアカウント導線としてヘッダー右側に固定するため
 * ここには含めない。
 */
export const DEFAULT_NAV_ITEMS: readonly NavKey[] = [
    "home",
    "donate",
    "dashboard",
    "register",
    "claim",
];

/** 表示用に解決した nav 項目（キーと遷移先のペア）。 */
export interface ResolvedNavItem {
    readonly key: NavKey;
    readonly href: string;
}

/**
 * 共通 nav（DEFAULT_NAV_ITEMS）を href 付きの項目リストに解決して返す。
 * 全ページで同じ並びを保つため、ページごとの出し分けは行わない。
 */
export function resolveNavItems(): readonly ResolvedNavItem[] {
    return DEFAULT_NAV_ITEMS.map((key) => ({ key, href: NAV_DEFS[key].href }));
}
