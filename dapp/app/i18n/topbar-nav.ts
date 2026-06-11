// トップバーの nav 構成を 1 箇所に集約する。表示する項目はページごとに異なる
// （既定 6 項目 / register 5 項目 / mypage 3 項目）ため、表示したいキーの並びを
// items で受け取り、各キーの遷移先（href）を付けて返す純粋関数にする。
// 文言は messages の topbar.nav.* カタログから引くため、ここでは持たない。

export type NavKey =
    | "home"
    | "donate"
    | "dashboard"
    | "leaderboard"
    | "register"
    | "claim"
    | "mypage";

/** 各 nav 項目の遷移先。キーと href の対応をここで一元管理する。 */
export const NAV_DEFS: Record<NavKey, { readonly href: string }> = {
    home: { href: "/" },
    donate: { href: "/donate" },
    dashboard: { href: "/dashboard" },
    leaderboard: { href: "/leaderboard" },
    register: { href: "/register" },
    claim: { href: "/claim" },
    mypage: { href: "/mypage" },
};

/** 既定のサイト nav。home / donate / dashboard / claim ページが使う 6 項目。 */
export const DEFAULT_NAV_ITEMS: readonly NavKey[] = [
    "home",
    "donate",
    "dashboard",
    "leaderboard",
    "register",
    "claim",
];

/** 表示用に解決した nav 項目（キーと遷移先のペア）。 */
export interface ResolvedNavItem {
    readonly key: NavKey;
    readonly href: string;
}

/**
 * 表示したいキー並びから、href 付きの nav 項目リストを作る。
 * items を省略すると既定の 6 項目を返す。順序は items の指定どおりに保つ。
 */
export function resolveNavItems(items?: readonly NavKey[]): readonly ResolvedNavItem[] {
    return (items ?? DEFAULT_NAV_ITEMS).map((key) => ({ key, href: NAV_DEFS[key].href }));
}
