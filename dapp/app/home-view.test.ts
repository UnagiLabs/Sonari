import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appDir = dirname(fileURLToPath(import.meta.url));
const homeViewSource = readFileSync(resolve(appDir, "home-view.tsx"), "utf8");
const globalsSource = readFileSync(resolve(appDir, "globals.css"), "utf8");

const removedHomeStatsTokens = [
    "statKeys",
    "statValues",
    "$3.2M",
    "$1.2M",
    "totalDonated",
    "reliefDelivered",
    "activePools",
    "verifiedEvents",
    "home.stats.",
    "stats.",
    "metrics-strip hero-stats-grid",
    "StatCard",
] as const;

describe("home view dummy stats removal", () => {
    it("トップページのダミー指標実装を残さない", () => {
        for (const token of removedHomeStatsTokens) {
            expect(homeViewSource, token).not.toContain(token);
        }
    });

    it("トップページ専用の指標グリッド CSS を残さない", () => {
        expect(globalsSource).not.toContain(".hero-stats-grid");
    });

    it("dashboard の指標表示 CSS は残す", () => {
        expect(globalsSource).toContain(".metrics-strip");
        expect(globalsSource).toContain(".metric-item");
        expect(globalsSource).toContain(".dashboard-metrics");
    });
});

// 実スポンサー7社。指定の並び順（Sui → Walrus → DeepBook → Mysten Labs →
// Scallop.io → OpenZeppelin → OtterSec）で定義する。logo は表示に使う画像パス。
const realSponsors = [
    { name: "Sui", logo: "/assets/sponsors/sui.png" },
    { name: "Walrus", logo: "/assets/sponsors/walrus.svg" },
    { name: "DeepBook", logo: "/assets/sponsors/deepbook.png" },
    { name: "Mysten Labs", logo: "/assets/sponsors/mysten-labs.png" },
    { name: "Scallop.io", logo: "/assets/sponsors/scallop.png" },
    { name: "OpenZeppelin", logo: "/assets/sponsors/openzeppelin.png" },
    { name: "OtterSec", logo: "/assets/sponsors/ottersec.png" },
] as const;

// ダミー実装の痕跡を表すトークン。
// Aizome Foundation / Kibou Capital / Midori Logistics は corporateDonors にも
// 出るため、スポンサー欄だけに使われていた 9 社名と CSS マーカーで検査する。
const removedSponsorTokens = [
    "Hinode Bank",
    "Sora Networks",
    "Kogane Energy",
    "Yume Robotics",
    "Hana Health",
    "Niji Studios",
    "Kawa Mobility",
    "Tomoshibi Co-op",
    "Mori Cloud",
    "logo-square",
    "type Sponsor",
    "oklch(",
] as const;

describe("home view sponsor logos", () => {
    it("ダミースポンサー（色付き四角＋イニシャル）の実装を残さない", () => {
        for (const token of removedSponsorTokens) {
            expect(homeViewSource, token).not.toContain(token);
        }
    });

    it("ダミー用の .logo-square CSS を残さない", () => {
        expect(globalsSource).not.toContain(".logo-square");
    });

    it("実スポンサー7社の社名とロゴパスを持つ", () => {
        for (const sponsor of realSponsors) {
            expect(homeViewSource, sponsor.name).toContain(sponsor.name);
            expect(homeViewSource, sponsor.logo).toContain(sponsor.logo);
        }
    });

    it("実スポンサーが指定順で並ぶ", () => {
        const positions = realSponsors.map((sponsor) =>
            homeViewSource.indexOf(sponsor.logo),
        );
        for (const position of positions) {
            expect(position).toBeGreaterThanOrEqual(0);
        }
        const sorted = [...positions].sort((a, b) => a - b);
        expect(positions).toEqual(sorted);
    });
});

// モックのプール金額。実残高化で home-view.tsx から消えること。
const removedPoolMockTokens = ["$1.28M", "$2.10M", "$820K", "$642K", "$980K", "$337K"] as const;

describe("home view featured pools", () => {
    it("モックのプール金額を残さない", () => {
        for (const token of removedPoolMockTokens) {
            expect(homeViewSource, token).not.toContain(token);
        }
    });

    it("実データ取得（deriveFeaturedPools / readDashboardPools）を使う", () => {
        expect(homeViewSource).toContain("deriveFeaturedPools");
        expect(homeViewSource).toContain("readDashboardPools");
    });

    it("読み込み中と失敗の状態を持つ（fail-close）", () => {
        expect(homeViewSource).toContain('status: "loading"');
        expect(homeViewSource).toContain('status: "error"');
    });

    it("メインプール画像を新パスに差し替え、旧パスを残さない", () => {
        expect(homeViewSource).toContain("/assets/pool_main_support.jpg");
        expect(homeViewSource).not.toContain("/assets/donation_flood.webp");
    });
});

// Top supporters 削除の検査。HOME 専用の実装トークンが残らないことを見る。
// Aizome / Kibou / Midori は corporateDonors にのみ残っていた社名なので、削除後は消える。
// type Donor で検査し、individualDonors などへの部分一致誤検知を避ける。
const removedSupportersTokens = [
    "SupporterList",
    "SupporterGroup",
    "individualDonors",
    "corporateDonors",
    "type Donor",
    "supporters-title",
    "home.supporters",
    "Aizome Foundation",
    "Kibou Capital",
    "Midori Logistics",
] as const;

// ダッシュボードの SupporterColumn が使う共有 CSS。HOME 削除で消してはいけない。
const sharedSupporterClasses = [
    ".supporter-group",
    ".supporter-group-label",
    ".row-item",
    ".row-name",
    ".row-meta",
    ".row-amount",
    ".avatar",
    ".avatar-sq",
] as const;

describe("home view top supporters removal", () => {
    it("HOME から Top supporters の実装を残さない", () => {
        for (const token of removedSupportersTokens) {
            expect(homeViewSource, token).not.toContain(token);
        }
    });

    it("HOME 専用の .supporter-list CSS を残さない", () => {
        expect(globalsSource).not.toContain(".supporter-list");
    });

    it("ダッシュボード共有の supporter / row / avatar CSS は残す", () => {
        for (const cls of sharedSupporterClasses) {
            expect(globalsSource, cls).toContain(cls);
        }
    });
});
