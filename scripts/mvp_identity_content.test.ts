import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CONTENT_FILES = [
    "dapp/app/page.tsx",
    "dapp/public/sonari_overview.html",
    "contracts/smoke.md",
] as const;

function readRepoFile(filePath: string): string {
    return readFileSync(path.resolve(process.cwd(), filePath), "utf8");
}

describe("MVP identity gate content", () => {
    it("states the dapp recipient and provider payout route", () => {
        const page = readRepoFile("dapp/app/page.tsx");

        expect(page).toMatch(/Membership\s+SBT\s+owner/);
        expect(page).toContain("KYC and World ID follow the same full-support route");
    });

    it("keeps the overview and smoke plan aligned with SBT-owner payout", () => {
        const overview = readRepoFile("dapp/public/sonari_overview.html");
        const smoke = readRepoFile("contracts/smoke.md");

        expect(overview).toContain("KYC verified");
        expect(overview).toContain("World ID verified");
        expect(overview).toContain("SBT owner");
        expect(smoke).toContain("SBT owner");
        expect(smoke).toContain("KYC / World ID はどちらも満額 route");
    });

    it("does not reintroduce legacy identity-flow terms", () => {
        const combined = CONTENT_FILES.map(readRepoFile).join("\n");

        expect(combined).not.toMatch(/registration[_ -]?fee/i);
        expect(combined).not.toMatch(/payout[_ -]?address/i);
        expect(combined).not.toMatch(/residence[_ -]?confidence/i);
        expect(combined).not.toMatch(/confidence[_ -]?discount/i);
    });
});
