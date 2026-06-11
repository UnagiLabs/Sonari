import type { NavKey, ResolvedNavItem } from "./topbar-nav";

// ハンバーガーメニューに表示する nav 項目の見た目モデルを組み立てる純粋関数。
// JSX を持たないため単体テストしやすく、SiteMobileMenu は結果を並べるだけにする。

/** メニューに 1 行として並べる nav 項目（リンク先・表示名・クラスを解決済み）。 */
export interface MobileMenuItem {
    readonly key: NavKey;
    readonly href: string;
    readonly label: string;
    readonly className: string;
}

/**
 * 表示する nav 項目に、翻訳済みラベルと active クラスを付けて返す。
 * 現在ページ（active）のリンクにだけ `nav-item active` を付け、他は `nav-item`。
 * 並びは渡した items の順序を保つ。
 */
export function buildMobileMenuItems(
    items: readonly ResolvedNavItem[],
    active: NavKey,
    navLabels: Readonly<Record<NavKey, string>>,
): readonly MobileMenuItem[] {
    return items.map((item) => ({
        key: item.key,
        href: item.href,
        label: navLabels[item.key],
        className: item.key === active ? "nav-item active" : "nav-item",
    }));
}
