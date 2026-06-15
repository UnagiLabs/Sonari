import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// home の文言は i18n 化で page.tsx から英語カタログ（messages/en.json）へ移動した。
// dapp の文言ガードは、英語コピーの単一情報源であるカタログを参照する。
const CONTENT_FILES = [
    "dapp/messages/en.json",
    "dapp/public/sonari_overview.html",
    "docs/internal/contracts_spec.md",
] as const;

function readRepoFile(filePath: string): string {
    return readFileSync(path.resolve(process.cwd(), filePath), "utf8");
}

describe("MVP identity gate content", () => {
    it("states the dapp recipient and provider payout route", () => {
        const messages = readRepoFile("dapp/messages/en.json");

        expect(messages).toMatch(/Membership\s+SBT\s+owner/);
        expect(messages).toContain("KYC and World ID follow the same full-support route");
    });

    it("keeps the overview and smoke plan aligned with SBT-owner payout", () => {
        const overview = readRepoFile("dapp/public/sonari_overview.html");
        const contractsSpec = readRepoFile("docs/internal/contracts_spec.md");

        expect(overview).toContain("KYC verified");
        expect(overview).toContain("World ID verified");
        expect(overview).toContain("SBT owner");
        expect(contractsSpec).toContain("SBT owner");
        expect(contractsSpec).toContain("KYC / World ID どちらも満額");
    });

    it("does not reintroduce legacy identity-flow terms", () => {
        const combined = CONTENT_FILES.map(readRepoFile).join("\n");

        expect(combined).not.toMatch(/registration[_ -]?fee/i);
        expect(combined).not.toMatch(/payout[_ -]?address/i);
        expect(combined).not.toMatch(/residence[_ -]?confidence/i);
        expect(combined).not.toMatch(/confidence[_ -]?discount/i);
    });
});
