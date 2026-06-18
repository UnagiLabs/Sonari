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
        expect(donateViewSource).toContain("donate-layout");
        expect(donateViewSource).toContain('className="donate-form"');
        expect(donateViewSource).toContain("executeWalletTransaction");
    });

    it("寄付ページに緊急バナーを描画しない", () => {
        expect(donateViewSource).not.toContain("<EmergencyBanner");
        expect(donateViewSource).not.toContain("EmergencyBannerSection");
        expect(donateViewSource).not.toContain("handleBannerDonate");
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

    it("embedded の送金結果は寄付実行後（idle 以外）にだけ出す分岐がある", () => {
        // idle のとき resultPanel を描かず、寄付実行で txState が idle 以外になってから出す。
        expect(donateViewSource).toMatch(/txState\.status\s*!==\s*"idle"/u);
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

describe("/donate single-column redesign", () => {
    it("右サイドの配分見積もりと DonorPass ノート枠を描画しない", () => {
        expect(donateViewSource).not.toContain('className="donate-side"');
        expect(donateViewSource).not.toContain('aria-label={t("split.title")}');
        expect(donateViewSource).not.toContain("buildDonateSplitRows");
        expect(donateViewSource).not.toContain("selectedAmountLabel");
        expect(donateViewSource).not.toContain("<aside");
        expect(donateViewSource).not.toContain('className="donate-note"');
    });

    it("通常表示でも送金結果は実行後だけフォーム直下に描画する", () => {
        expect(donateViewSource).toContain("{txState.status !== \"idle\" ? resultPanel : null}");
        expect(donateViewSource).not.toContain("donate-side");
    });

    it("ヒーロー直下のメトリクスは main pool 実データから出す", () => {
        expect(donateViewSource).toContain("parseMainPoolObject");
        expect(donateViewSource).toContain("readClaimCampaigns");
        expect(donateViewSource).toContain("buildDisasterPoolViews");
        expect(donateViewSource).toContain("mainPool.totalReceivedUsdc");
        expect(donateViewSource).toContain("mainPool.totalFloorFundedUsdc");
        expect(donateViewSource).toContain('pool.status === "active"');
        expect(donateViewSource).toContain('className="metrics-strip donate-metrics"');
        expect(donateViewSource).toContain('t("metrics.totalReceived")');
        expect(donateViewSource).toContain('t("metrics.totalSent")');
        expect(donateViewSource).toContain('t("metrics.activeReliefPools")');
    });

    it("DonorPass ノートを送信ボタン直下の一行にする", () => {
        expect(donateViewSource).toContain('t("note.inline")');
        expect(donateViewSource).toContain('style={{ textAlign: "center" }}');
    });

    it("通常の donate 画面ではキャンペーン候補リストを出さず pools への導線を出す", () => {
        expect(donateViewSource).not.toContain('name="donateCampaign"');
        expect(donateViewSource).not.toContain("handleCampaignChange");
        expect(donateViewSource).not.toContain('t("form.campaignLegend")');
        expect(donateViewSource).toContain('href="/pools"');
        expect(donateViewSource).toContain('className="choice-option donate-specific-disaster-choice"');
        expect(donateViewSource).not.toContain('className="choice-link-dot"');
        expect(donateViewSource).toContain('t("types.specificDisaster.label")');
        expect(donateViewSource).toContain("→");
    });

    it("カテゴリ寄付では実カテゴリだけを選択肢として表示する", () => {
        expect(donateViewSource).toContain('name="donateCategory"');
        expect(donateViewSource).toContain("buildCategoryListItems(destinationState.categories)");
        expect(donateViewSource).toContain("formatCategoryOptionLabel");
        expect(donateViewSource).toContain('t("category.options.earthquake")');
        expect(donateViewSource).not.toContain("pool-select-option-disabled");
    });

    it("donate layout と metrics は 820px の単一カラムに収める", () => {
        expect(globalsSource).toMatch(
            /\.donate-layout\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/u,
        );
        expect(globalsSource).toMatch(
            /\.donate-metrics\s*\{[^}]*grid-template-columns: repeat\(3, 1fr\)/u,
        );
        expect(globalsSource).toContain("max-width: 820px");
        expect(globalsSource).toContain(".donate-metrics");
    });

    it("結果カードは opacity ではなく transform だけで出現させる", () => {
        const status = cssRuleBody(".submit-status");
        expect(status).toContain("opacity: 1");
        expect(status).toContain("animation: resultIn 0.4s ease both");

        const keyframes = globalsSource.match(/@keyframes resultIn\s*\{([\s\S]*?)\n\}/u)?.[1] ?? "";
        expect(keyframes).toContain("transform: translateY(10px)");
        expect(keyframes).toContain("transform: none");
        expect(keyframes).not.toContain("opacity");
    });

    it("新しい donate i18n キーが en/ja に存在する", () => {
        for (const locale of ["en", "ja"] as const) {
            const messages = readMessages(locale);
            const donateMessages = messages["donate"];
            if (!isRecord(donateMessages)) {
                throw new Error("donate messages must be an object");
            }
            const form = donateMessages["form"];
            const types = donateMessages["types"];
            const category = donateMessages["category"];
            const metrics = donateMessages["metrics"];
            const note = donateMessages["note"];
            if (
                !isRecord(form) ||
                !isRecord(types) ||
                !isRecord(category) ||
                !isRecord(metrics) ||
                !isRecord(note)
            ) {
                throw new Error("donate form/types/category/metrics/note messages must be objects");
            }
            const specificDisaster = types["specificDisaster"];
            const categoryOptions = category["options"];
            if (!isRecord(specificDisaster) || !isRecord(categoryOptions)) {
                throw new Error("donate specific disaster/category options messages must be objects");
            }
            expect(metrics).toHaveProperty("totalReceived");
            expect(metrics).toHaveProperty("totalSent");
            expect(metrics).toHaveProperty("activeReliefPools");
            expect(specificDisaster).toHaveProperty("label");
            expect(specificDisaster).toHaveProperty("description");
            expect(categoryOptions).toHaveProperty("earthquake");
            expect(note).toHaveProperty("inline");
        }
    });
});
