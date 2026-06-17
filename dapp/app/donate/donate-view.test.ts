import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const donateViewSource = readFileSync(resolve(here, "donate-view.tsx"), "utf8");
const siteTopbarSource = readFileSync(resolve(appDir, "i18n/site-topbar.tsx"), "utf8");
const claimViewSource = readFileSync(resolve(appDir, "claim/claim-list-view.tsx"), "utf8");
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

function heroMessages(messages: JsonRecord, namespace: "donate" | "claim"): JsonRecord {
    const namespaceMessages = messages[namespace];
    if (!isRecord(namespaceMessages)) {
        throw new Error(`${namespace} messages must be an object`);
    }
    const hero = namespaceMessages.hero;
    if (!isRecord(hero)) {
        throw new Error(`${namespace}.hero messages must be an object`);
    }
    return hero;
}

function cssRuleBody(selector: string): string {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = globalsSource.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
    if (match?.[1] === undefined) {
        throw new Error(`${selector} rule not found`);
    }
    return match[1];
}

describe("/donate wallet section removal", () => {
    it("hero に本文側の Wallet panel を描画しない", () => {
        expect(donateViewSource).not.toContain('className="donate-wallet-panel"');
        expect(donateViewSource).not.toContain('t("hero.walletTag")');
        expect(donateViewSource).not.toContain('t("hero.walletBody")');
        expect(donateViewSource).not.toContain("../wallet/wallet-connect");
    });

    it("寄付画面の主要な経路は残す", () => {
        expect(donateViewSource).toContain('<SiteTopbar active="donate" locale={locale} />');
        expect(donateViewSource).toContain("<EmergencyBanner");
        expect(donateViewSource).toContain('className="donate-layout"');
        expect(donateViewSource).toContain('className="donate-form"');
        expect(donateViewSource).toContain("executeWalletTransaction");
    });

    it("ヘッダーの Wallet 接続は残す", () => {
        expect(siteTopbarSource).toContain(
            'import { LoginEntryPoint, LoginEntryPointFallback } from "../wallet/login-entry-point";',
        );
        expect(siteTopbarSource).toContain(
            "<Suspense fallback={<LoginEntryPointFallback />}>",
        );
        expect(siteTopbarSource).toContain("<LoginEntryPoint />");
    });

    it("donate hero に空の右カラムと不要な panel CSS を残さない", () => {
        expect(cssRuleBody(".donate-hero")).not.toContain("grid-template-columns");
        expect(globalsSource).not.toContain(".donate-wallet-panel");
    });

    it("claim 側の Wallet panel は残す", () => {
        expect(claimViewSource).toContain('className="claim-wallet-panel"');
        expect(claimViewSource).toContain('t("hero.walletTag")');
        expect(claimViewSource).toContain('t("hero.walletBody")');
        expect(globalsSource).toContain(".claim-wallet-panel");
    });

    it("donate の不要な Wallet 文言だけを削除する", () => {
        for (const locale of ["en", "ja"] as const) {
            const messages = readMessages(locale);
            const donateHero = heroMessages(messages, "donate");
            const claimHero = heroMessages(messages, "claim");

            expect(donateHero).not.toHaveProperty("walletTag");
            expect(donateHero).not.toHaveProperty("walletBody");
            expect(claimHero).toHaveProperty("walletTag");
            expect(claimHero).toHaveProperty("walletBody");
        }
    });
});
