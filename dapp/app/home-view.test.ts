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
