// ---------------------------------------------------------------------------
// pools-view.test.ts – ソース文字列検証テスト
//
// STEP3: /pools 一覧ページの実装を検証する。
// ビルドを経由せずソース文字列を直接読み、実装の構造・依存・文言を確認する。
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const poolsViewSource = readFileSync(resolve(here, "pools-view.tsx"), "utf8");

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMessages(locale: "en" | "ja"): JsonRecord {
    const parsed: unknown = JSON.parse(
        readFileSync(resolve(here, "../../messages", `${locale}.json`), "utf8"),
    );
    if (!isRecord(parsed)) {
        throw new Error(`${locale} messages root must be an object`);
    }
    return parsed;
}

function getNestedKeys(obj: JsonRecord, prefix = ""): string[] {
    const keys: string[] = [];
    for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix.length > 0 ? `${prefix}.${key}` : key;
        if (isRecord(value)) {
            keys.push(...getNestedKeys(value, fullKey));
        } else {
            keys.push(fullKey);
        }
    }
    return keys;
}

// ---------------------------------------------------------------------------
// データ依存: readClaimCampaigns + buildDisasterPoolViews を使う
// ---------------------------------------------------------------------------

describe("pools-view データ依存", () => {
    it("readClaimCampaigns を使っている", () => {
        expect(poolsViewSource).toContain("readClaimCampaigns");
    });

    it("buildDisasterPoolViews を使っている", () => {
        expect(poolsViewSource).toContain("buildDisasterPoolViews");
    });

    it("donate config（NEXT_PUBLIC_SONARI_FUNDING_PACKAGE_ID）を使っている", () => {
        expect(poolsViewSource).toContain("readDonateEnvConfig");
    });
});

// ---------------------------------------------------------------------------
// リンク先: /donate/<disasterEventId> への Link
// ---------------------------------------------------------------------------

describe("pools-view リンク構造", () => {
    it("href が /donate/ を含むリンクを生成する（view.href を使っている）", () => {
        expect(poolsViewSource).toContain("view.href");
    });

    it("next/link の Link を使っている", () => {
        expect(poolsViewSource).toContain("next/link");
    });

    it("Main Pool 専用の文言・識別子を出していない", () => {
        expect(poolsViewSource).not.toContain("mainPoolId");
        expect(poolsViewSource).not.toContain("Main Pool");
        expect(poolsViewSource).not.toContain("main-pool");
    });
});

// ---------------------------------------------------------------------------
// loading / error / empty の分岐
// ---------------------------------------------------------------------------

describe("pools-view 状態分岐", () => {
    it("loading 状態を持つ", () => {
        expect(poolsViewSource).toContain('status: "loading"');
    });

    it("error 状態と retry ボタンを持つ（fail-close）", () => {
        expect(poolsViewSource).toContain('status: "error"');
    });

    it("0件表示の i18n キーを参照している", () => {
        // useTranslations("pools") 配下なので t("empty") と書く
        expect(poolsViewSource).toContain('t("empty")');
    });
});

// ---------------------------------------------------------------------------
// i18n: en/ja 両方に pools namespace のキーが揃っている
// ---------------------------------------------------------------------------

describe("pools メッセージ整合", () => {
    const enMessages = readMessages("en");
    const jaMessages = readMessages("ja");

    const enPools = (enMessages as JsonRecord).pools;
    const jaPools = (jaMessages as JsonRecord).pools;

    it("en.json に pools namespace が存在する", () => {
        expect(isRecord(enPools)).toBe(true);
    });

    it("ja.json に pools namespace が存在する", () => {
        expect(isRecord(jaPools)).toBe(true);
    });

    it("en と ja の pools キーが完全一致する", () => {
        if (!isRecord(enPools) || !isRecord(jaPools)) {
            throw new Error("pools namespace is not a record");
        }
        const enKeys = getNestedKeys(enPools).sort();
        const jaKeys = getNestedKeys(jaPools).sort();
        expect(jaKeys).toEqual(enKeys);
    });

    it("必須キーが en.json に存在する", () => {
        if (!isRecord(enPools)) {
            throw new Error("en pools is not a record");
        }
        const keys = getNestedKeys(enPools);
        const requiredKeys = [
            "eyebrow",
            "title",
            "sub",
            "loading",
            "error",
            "retry",
            "empty",
            "card.region",
            "card.affectedCells",
            "card.donationEnd",
            "card.balance",
            "card.totalDonated",
            "card.totalPaid",
            "card.donate",
        ];
        for (const key of requiredKeys) {
            expect(keys, `pools.${key}`).toContain(key);
        }
    });
});
