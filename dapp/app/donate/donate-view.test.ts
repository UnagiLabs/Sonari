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
        expect(donateViewSource).toContain("donate-layout");
        expect(donateViewSource).toContain('className="donate-form"');
        expect(donateViewSource).toContain("executeWalletTransaction");
    });

    it("ヘッダーの Wallet 接続は残す", () => {
        expect(siteTopbarSource).toContain('import { WalletConnect } from "../wallet/wallet-connect";');
        expect(siteTopbarSource).toContain("<WalletConnect />");
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

describe("DonateView initialMode / initialCampaignId / lockDestination props", () => {
    it("DonateView が initialMode prop を受け取る型定義を持つ", () => {
        expect(donateViewSource).toContain("initialMode");
    });

    it("DonateView が initialCampaignId prop を受け取る型定義を持つ", () => {
        expect(donateViewSource).toContain("initialCampaignId");
    });

    it("DonateView が lockDestination prop を受け取る型定義を持つ", () => {
        expect(donateViewSource).toContain("lockDestination");
    });

    it("state の mode 初期値を initialMode から設定する分岐がある", () => {
        // useState の初期値に initialMode を使う
        expect(donateViewSource).toContain("initialMode");
        // 初期値の三項演算子または ?? での活用
        expect(donateViewSource).toMatch(/initialMode[^;]*\?\?|initialMode[^;]*\?[^:]*:/);
    });

    it("state の campaignId 初期値を initialCampaignId から設定する分岐がある", () => {
        expect(donateViewSource).toContain("initialCampaignId");
        expect(donateViewSource).toMatch(/initialCampaignId[^;]*\?\?|initialCampaignId[^;]*\?[^:]*:/);
    });

    it("lockDestination が true のとき mode 切替ラジオを非描画にする分岐がソースにある", () => {
        // lockDestination を条件に使う JSX 分岐が存在する
        expect(donateViewSource).toContain("lockDestination");
        // !lockDestination または lockDestination ? ... : ... などで非描画する
        expect(donateViewSource).toMatch(/lockDestination[^{]*[?!]/);
    });

    it("lockDestination true 時に固定寄付先ブロックを描画する要素がある", () => {
        // locked-destination などのクラスまたは i18n キーで固定表示ブロックがある
        expect(donateViewSource).toMatch(/locked-destination|lockedDestination|lockDestination.*className|donate\.locked/);
    });

    it("DonateView が embedded prop を受け取る型定義を持つ", () => {
        expect(donateViewSource).toContain("embedded");
    });

    it("embedded のとき chrome なしでフォーム部分のみ返す分岐がある", () => {
        // embedded のときは watercolor-bg/SiteTopbar/EmergencyBanner/donate-hero を描画せず
        // donateForm（donate-layout）だけ返す。/donate/[eventId] の二重 chrome を防ぐ。
        expect(donateViewSource).toMatch(/if\s*\(embedded\)/u);
        expect(donateViewSource).toContain("donateForm");
    });

    it("auto-select effect で initialCampaignId が指定済みの場合は上書きしない分岐がある", () => {
        // initialCampaignId が与えられたとき auto-select で上書きしないロジック
        expect(donateViewSource).toContain("initialCampaignId");
        // initialCampaignId を deps 配列または条件に使う箇所
        expect(donateViewSource).toMatch(/initialCampaignId/);
    });

    it("props 未指定時の従来挙動用トークンを維持する", () => {
        // 既存の非回帰トークン
        expect(donateViewSource).toContain('<SiteTopbar active="donate" locale={locale} />');
        expect(donateViewSource).toContain("<EmergencyBanner");
        expect(donateViewSource).toContain("donate-layout");
        expect(donateViewSource).toContain('className="donate-form"');
        expect(donateViewSource).toContain("executeWalletTransaction");
    });

    it("lockDestination 関連の i18n キーが en メッセージに存在する", () => {
        const messages = readMessages("en");
        const donateMessages = messages["donate"];
        if (!isRecord(donateMessages)) {
            throw new Error("donate messages must be an object");
        }
        // locked 固定表示用のキーが存在する（form.lockedDestination など）
        const form = donateMessages["form"];
        if (!isRecord(form)) {
            throw new Error("donate.form messages must be an object");
        }
        expect(form).toHaveProperty("lockedDestination");
    });

    it("lockDestination 関連の i18n キーが ja メッセージに存在する", () => {
        const messages = readMessages("ja");
        const donateMessages = messages["donate"];
        if (!isRecord(donateMessages)) {
            throw new Error("donate messages must be an object");
        }
        const form = donateMessages["form"];
        if (!isRecord(form)) {
            throw new Error("donate.form messages must be an object");
        }
        expect(form).toHaveProperty("lockedDestination");
    });
});
