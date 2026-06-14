import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    disabledReasonMessageKey,
    type MembershipDisabledReason,
} from "./steps/membership-gate";

// en/ja の翻訳カタログが構造的に同一（キー集合が完全一致・値は空でない文字列）で
// あることを固定するテスト。キーの欠落や空訳が UI に英語フォールバックや空文字と
// して漏れるのを防ぐ。

const messagesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../messages");
const doneStepSource = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "steps/done-step.tsx"),
    "utf8",
);

function loadCatalog(locale: string): Record<string, unknown> {
    return JSON.parse(readFileSync(resolve(messagesDir, `${locale}.json`), "utf8")) as Record<
        string,
        unknown
    >;
}

/** ネストしたカタログを "a.b.c" 形式のキー一覧へ平坦化する。 */
function flattenKeys(value: unknown, prefix: string, out: Map<string, unknown>): void {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        for (const [key, child] of Object.entries(value)) {
            flattenKeys(child, prefix.length === 0 ? key : `${prefix}.${key}`, out);
        }
        return;
    }
    out.set(prefix, value);
}

const en = new Map<string, unknown>();
const ja = new Map<string, unknown>();
flattenKeys(loadCatalog("en"), "", en);
flattenKeys(loadCatalog("ja"), "", ja);

const removedLeaderboardLinkKeys = [
    "topbar.nav.leaderboard",
    "home.supporters.fullLeaderboard",
    "home.footer.linkLeaderboard",
    "dashboard.supportersPanel.eyebrow",
    "dashboard.supportersPanel.action",
] as const;

const removedHomeStatsKeys = [
    "home.stats.totalDonated.label",
    "home.stats.totalDonated.meta",
    "home.stats.reliefDelivered.label",
    "home.stats.reliefDelivered.meta",
    "home.stats.activePools.label",
    "home.stats.activePools.meta",
    "home.stats.verifiedEvents.label",
    "home.stats.verifiedEvents.meta",
] as const;

const removedSupportersKeys = [
    "home.supporters.eyebrow",
    "home.supporters.title",
    "home.supporters.individuals",
    "home.supporters.corporate",
] as const;

const removedStatementKeys = [
    "register.wizard.residence.statements.0",
    "register.wizard.residence.statements.1",
    "register.wizard.residence.statements.2",
    "register.wizard.residence.statementsLegend",
    "register.wizard.membership.statements.0",
    "register.wizard.membership.statements.1",
    "register.wizard.membership.statements.2",
    "register.wizard.membership.statementsLegend",
    "register.wizard.membership.nextHint",
] as const;

const removedPickerKeys = [
    "register.wizard.residence.picker.summaryResolution",
    "register.wizard.residence.picker.summaryCellId",
    "register.wizard.residence.picker.summaryAllowlist",
    "register.wizard.residence.picker.advancedSummary",
    "register.wizard.residence.picker.advancedLabel",
    "register.wizard.residence.picker.advancedHelp",
    "register.wizard.residence.picker.invalidCellInput",
] as const;

describe("messages catalog parity", () => {
    it("en と ja のキー集合が完全に一致する", () => {
        expect([...ja.keys()].sort()).toEqual([...en.keys()].sort());
    });

    it("すべての値が空でない文字列", () => {
        for (const [key, value] of [...en, ...ja]) {
            expect(typeof value, key).toBe("string");
            expect((value as string).trim().length, key).toBeGreaterThan(0);
        }
    });

    it("ICU プレースホルダ（{name}）が en/ja で一致する", () => {
        for (const [key, enValue] of en) {
            const jaValue = ja.get(key);
            const placeholders = (text: unknown): string[] =>
                typeof text === "string" ? (text.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort() : [];
            expect(placeholders(jaValue), key).toEqual(placeholders(enValue));
        }
    });

    it("404 ページの必須文言を en/ja catalog で管理する", () => {
        for (const key of [
            "notFound.eyebrow",
            "notFound.title",
            "notFound.body",
            "notFound.homeCta",
        ]) {
            expect(en.has(key), key).toBe(true);
            expect(ja.has(key), key).toBe(true);
        }
    });

    it("本人確認 submit 成功後の待ち時間案内を日本語 catalog で管理する", () => {
        expect(ja.get("register.wizard.identity.submit.processingNotice")).toBe(
            "処理に数分〜1時間程度かかります。処理状況はmypageで確認できます。",
        );
    });

    it("登録完了画面の主要 CTA はマイページへ遷移する", () => {
        expect(doneStepSource).toContain('href="/mypage"');
        expect(doneStepSource).toContain('t("mypageCta")');
        expect(doneStepSource).not.toContain('href="/dashboard"');
        expect(ja.get("register.wizard.done.mypageCta")).toBe("マイページで確認");
        expect(en.get("register.wizard.done.mypageCta")).toBe("Check My Page");
    });

    it("/leaderboard 導線で使っていた文言キーを残さない", () => {
        for (const key of removedLeaderboardLinkKeys) {
            expect(en.has(key), key).toBe(false);
            expect(ja.has(key), key).toBe(false);
        }
    });

    it("トップページのダミー指標で使っていた文言キーを残さない", () => {
        for (const key of removedHomeStatsKeys) {
            expect(en.has(key), key).toBe(false);
            expect(ja.has(key), key).toBe(false);
        }
    });

    it("HOME の Top supporters で使っていた文言キーを残さない", () => {
        for (const key of removedSupportersKeys) {
            expect(en.has(key), key).toBe(false);
            expect(ja.has(key), key).toBe(false);
        }
    });

    it("welcome 集約で使わなくなった同意文言キーを残さない", () => {
        for (const key of removedStatementKeys) {
            expect(en.has(key), key).toBe(false);
            expect(ja.has(key), key).toBe(false);
        }
    });

    it("居住エリアUI整理で使わなくなった picker 文言キーを残さない", () => {
        for (const key of removedPickerKeys) {
            expect(en.has(key), key).toBe(false);
            expect(ja.has(key), key).toBe(false);
        }
    });

    it("welcome のプライバシー情報カードで使っていた文言キーを残さない", () => {
        // privacySummary と privacy.* を welcome から削除した。再追加を防ぐ。
        const removedPrivacyPrefix = "register.wizard.welcome.privacy";
        for (const key of [...en.keys(), ...ja.keys()]) {
            expect(key.startsWith(removedPrivacyPrefix), key).toBe(false);
        }
    });

    it("membership ゲートの disabled 理由キーが en/ja catalog に全て存在する", () => {
        // disabledReasonMessageKey が返すキーが削除済みキーを指していないことを固定する。
        // 削除された文言（旧 nextHint 等）を理由コードが参照すると missing key で UI が壊れる。
        const reasons: MembershipDisabledReason[] = [
            "wallet_disconnected",
            "residence_unselected",
            "submitting",
            "checking",
            "multiple",
            "lookup_error",
            "not_configured",
        ];
        for (const reason of reasons) {
            const key = `register.wizard.membership.${disabledReasonMessageKey(reason)}`;
            expect(en.has(key), key).toBe(true);
            expect(ja.has(key), key).toBe(true);
        }
    });
});
