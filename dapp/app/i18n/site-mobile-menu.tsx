import { buildMobileMenuItems } from "./mobile-menu-model";
import type { NavKey, ResolvedNavItem } from "./topbar-nav";

// 狭い画面（820px 以下）で表示するハンバーガーメニュー。
// JS を増やさないよう <details>/<summary> ベースにし、クリック・キーボードでの
// 開閉をブラウザ標準に任せる。文言は親（SiteTopbar）が next-intl で解決して渡すため、
// この部品は翻訳に依存せず純粋に保つ。表示ロジックは mobile-menu-model に集約する。

export function SiteMobileMenu({
    items,
    active,
    navLabels,
    menuLabel,
}: {
    readonly items: readonly ResolvedNavItem[];
    readonly active: NavKey;
    readonly navLabels: Readonly<Record<NavKey, string>>;
    readonly menuLabel: string;
}) {
    const menuItems = buildMobileMenuItems(items, active, navLabels);

    return (
        <details className="nav-menu">
            <summary aria-label={menuLabel} className="nav-menu-toggle">
                <span aria-hidden="true" className="nav-menu-icon" />
            </summary>
            <nav aria-label="Primary" className="nav-menu-panel">
                {menuItems.map((item) => (
                    <a className={item.className} href={item.href} key={item.key}>
                        {item.label}
                    </a>
                ))}
            </nav>
        </details>
    );
}
