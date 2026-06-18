import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const donateDir = resolve(here, "..");
const appDir = resolve(donateDir, "..");

const completeViewSource = readFileSync(resolve(here, "donation-complete-view.tsx"), "utf8");
const receiptViewSource = readFileSync(resolve(here, "donation-receipt-view.tsx"), "utf8");
const donateViewSource = readFileSync(resolve(donateDir, "donate-view.tsx"), "utf8");
const disasterViewSource = readFileSync(
    resolve(donateDir, "[eventId]/disaster-donate-view.tsx"),
    "utf8",
);
const globalsSource = readFileSync(resolve(appDir, "globals.css"), "utf8");

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

function donateNamespace(messages: JsonRecord, key: "complete" | "receipt"): JsonRecord {
    const donate = messages["donate"];
    if (!isRecord(donate)) {
        throw new Error("donate messages must be an object");
    }
    const namespace = donate[key];
    if (!isRecord(namespace)) {
        throw new Error(`donate.${key} messages must be an object`);
    }
    return namespace;
}

describe("DonationCompleteView source", () => {
    it("client component で発行ハンドラと主要文言を持つ", () => {
        expect(completeViewSource).toContain('"use client"');
        expect(completeViewSource).toContain("onIssueReceipt");
        expect(completeViewSource).toContain('t("title")');
        expect(completeViewSource).toContain('t("issueButton")');
        // 匿名トグル
        expect(completeViewSource).toContain('t("anonymous")');
        expect(completeViewSource).toContain('type="checkbox"');
    });
});

describe("DonationReceiptView source", () => {
    it("印刷可能な領収書として必要なトークンを持つ", () => {
        expect(receiptViewSource).toContain('"use client"');
        expect(receiptViewSource).toContain("receipt-card");
        expect(receiptViewSource).toContain("no-print");
        expect(receiptViewSource).toContain("window.print");
        expect(receiptViewSource).toContain("QRCodeSVG");
        expect(receiptViewSource).toContain("receiptNumber");
        expect(receiptViewSource).toContain('t("disclaimer")');
        // DonorPass 行は条件付きで描く
        expect(receiptViewSource).toContain("donorPassId");
    });

    it("DonationRecord は表示しない（ユーザー確定: 不要・TODO も作らない）", () => {
        expect(receiptViewSource).not.toContain("DonationRecord");
        expect(receiptViewSource).not.toContain("donationRecordId");
    });
});

describe("donate-view.tsx wiring", () => {
    it("既存の非回帰トークン（resultPanel / embedded / donateForm）を維持する", () => {
        expect(donateViewSource).toContain('{txState.status !== "idle" ? resultPanel : null}');
        expect(donateViewSource).toMatch(/if\s*\(embedded\)/u);
        expect(donateViewSource).toContain("donateForm");
    });

    it("完了/領収書の配線トークンを持つ", () => {
        expect(donateViewSource).toContain("DonationCompleteView");
        expect(donateViewSource).toContain("DonationReceiptView");
        expect(donateViewSource).toContain("receiptPhase");
        expect(donateViewSource).toContain("submittedAt");
        expect(donateViewSource).toContain("onSubmittedChange");
        expect(donateViewSource).toContain("completionScreen");
        expect(donateViewSource).toContain("destinationLabelOverride");
    });

    it("単一カラム再設計で外した識別子を再導入しない", () => {
        expect(donateViewSource).not.toContain("selectedAmountLabel");
        expect(donateViewSource).not.toContain("buildDonateSplitRows");
        expect(donateViewSource).not.toContain("donate-side");
        expect(donateViewSource).not.toContain("<aside");
        expect(donateViewSource).not.toContain('className="donate-note"');
        expect(donateViewSource).not.toContain('className="donate-wallet-panel"');
    });
});

describe("disaster-donate-view.tsx wiring", () => {
    it("送金成功で chrome を隠し DonateView に完了遷移を配線する", () => {
        expect(disasterViewSource).toContain("onSubmittedChange");
        expect(disasterViewSource).toContain("donationSubmitted");
        expect(disasterViewSource).toContain("destinationLabelOverride");
    });
});

describe("globals.css print styles", () => {
    it("領収書のみ A4 縦に印刷する規則を持つ", () => {
        expect(globalsSource).toContain("@media print");
        expect(globalsSource).toContain("@page");
        expect(globalsSource).toContain(".no-print");
        expect(globalsSource).toContain(".receipt-card");
    });
});

describe("donate i18n keys", () => {
    it("complete / receipt キーが en/ja 双方に存在する", () => {
        for (const locale of ["en", "ja"] as const) {
            const messages = readMessages(locale);
            const complete = donateNamespace(messages, "complete");
            const receipt = donateNamespace(messages, "receipt");

            expect(complete).toHaveProperty("title");
            expect(complete).toHaveProperty("issueButton");
            expect(complete).toHaveProperty("nameLabel");
            expect(complete).toHaveProperty("anonymous");

            expect(receipt).toHaveProperty("heading");
            expect(receipt).toHaveProperty("disclaimer");
            expect(receipt).toHaveProperty("print");
            const network = receipt["network"];
            if (!isRecord(network)) {
                throw new Error("donate.receipt.network must be an object");
            }
            expect(network).toHaveProperty("testnet");
        }
    });
});
