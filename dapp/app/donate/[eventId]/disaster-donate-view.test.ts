import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "../..");
const viewSource = readFileSync(resolve(here, "disaster-donate-view.tsx"), "utf8");

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMessages(locale: "en" | "ja"): JsonRecord {
    const parsed: unknown = JSON.parse(
        readFileSync(resolve(appDir, `../messages/${locale}.json`), "utf8"),
    );
    if (!isRecord(parsed)) {
        throw new Error(`${locale} messages root must be an object`);
    }
    return parsed;
}

describe("DisasterDonateView ソース検証", () => {
    it("DonateView に initialMode='campaign' を渡している", () => {
        expect(viewSource).toContain('initialMode="campaign"');
    });

    it("DonateView に initialCampaignId prop を渡している", () => {
        expect(viewSource).toContain("initialCampaignId");
    });

    it("DonateView に lockDestination prop を渡している", () => {
        expect(viewSource).toContain("lockDestination");
    });

    it("affectedAreaArtifactFromBaseUrl を使っている", () => {
        expect(viewSource).toContain("affectedAreaArtifactFromBaseUrl");
    });

    it("artifact が null のとき地図を描かない分岐がある", () => {
        // affectedAreaArtifact が null のとき AffectedAreaMap を描かない
        // null チェックパターン
        expect(viewSource).toMatch(/affectedAreaArtifact\s*!==?\s*null|affectedAreaArtifact\s*&&|affectedAreaArtifact\s*\?/u);
    });

    it("AffectedAreaMap に cellSource prop を渡している", () => {
        expect(viewSource).toContain("cellSource");
    });

    it("AffectedAreaMap をインポートしている", () => {
        expect(viewSource).toContain("AffectedAreaMap");
    });

    it("not-found 分岐がある", () => {
        // resolveCampaignByEvent が null のとき not-found 表示をする
        expect(viewSource).toContain("not-found");
    });

    it("/pools への戻りリンクがある", () => {
        expect(viewSource).toContain("/pools");
    });

    it("disasterDonate namespace の i18n キーを参照している", () => {
        expect(viewSource).toContain('useTranslations("disasterDonate")');
    });
});

describe("disasterDonate i18n キー整合", () => {
    function getDisasterDonateMessages(messages: JsonRecord): JsonRecord {
        const ns = messages["disasterDonate"];
        if (!isRecord(ns)) {
            throw new Error("disasterDonate namespace must be an object");
        }
        return ns;
    }

    const REQUIRED_KEYS = [
        "title",
        "notFoundTitle",
        "notFoundBody",
        "backToPools",
        "mapTitle",
        "regionLabel",
        "affectedCellsLabel",
        "donationEndLabel",
        "claimEndLabel",
        "balanceLabel",
        "totalDonatedLabel",
        "totalPaidLabel",
        "statusLabel",
    ];

    it("en.json に必須キーが揃っている", () => {
        const messages = readMessages("en");
        const ns = getDisasterDonateMessages(messages);
        for (const key of REQUIRED_KEYS) {
            expect(ns, `en.json の disasterDonate.${key} が存在する`).toHaveProperty(key);
        }
    });

    it("ja.json に必須キーが揃っている", () => {
        const messages = readMessages("ja");
        const ns = getDisasterDonateMessages(messages);
        for (const key of REQUIRED_KEYS) {
            expect(ns, `ja.json の disasterDonate.${key} が存在する`).toHaveProperty(key);
        }
    });

    it("en.json と ja.json のキーが一致している", () => {
        const enNs = getDisasterDonateMessages(readMessages("en"));
        const jaNs = getDisasterDonateMessages(readMessages("ja"));
        const enKeys = Object.keys(enNs).sort();
        const jaKeys = Object.keys(jaNs).sort();
        expect(enKeys).toEqual(jaKeys);
    });
});
