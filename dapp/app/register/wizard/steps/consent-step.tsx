"use client";

// Claude Design の "Consent Step" を取り込んだデザイン・文面。番号付きセクション
// （01 平易な要約 / 02 規約全文 / 03 同意）で構成する。規約全文は読了で読了バッジ
// とフェードが切り替わる演出のみで、Next の gating は従来どおり単一の同意チェック
// （disclaimersAccepted）に依存する。Back・Next 遷移／state 永続化／i18n は不変。

import { useTranslations } from "next-intl";
import { type UIEvent, useEffect, useRef, useState } from "react";
import { MEMBERSHIP_TERMS_VERSION } from "../../terms-version";

const summaryKeys = ["0", "1", "2"] as const;
const clauseKeys = ["0", "1", "2", "3", "4", "5"] as const;

// 平易な要約カードのアイコン（オンチェーン記録：六角形＋中心点）。装飾なので
// aria-hidden、色は CSS の currentColor に従う。
function OnchainGlyph() {
    return (
        <svg aria-hidden="true" className="consent-summary-glyph" viewBox="0 0 24 24">
            <polygon
                fill="none"
                points="12,2.5 20,7 20,17 12,21.5 4,17 4,7"
                stroke="currentColor"
                strokeWidth="1.7"
            />
            <circle cx="12" cy="12" fill="currentColor" r="2.4" />
        </svg>
    );
}

// 非公開（鍵）アイコン。
function PrivacyGlyph() {
    return (
        <svg aria-hidden="true" className="consent-summary-glyph" viewBox="0 0 24 24">
            <rect
                fill="none"
                height="9"
                rx="2"
                stroke="currentColor"
                strokeWidth="1.7"
                width="14"
                x="5"
                y="11"
            />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="1.7" />
        </svg>
    );
}

// 1 人 1 つ（円＋チェック）アイコン。
function MemberGlyph() {
    return (
        <svg aria-hidden="true" className="consent-summary-glyph" viewBox="0 0 24 24">
            <circle cx="12" cy="12" fill="none" r="9" stroke="currentColor" strokeWidth="1.7" />
            <path
                d="M9 12l2 2 4-4.5"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.7"
            />
        </svg>
    );
}

const summaryGlyphs = [OnchainGlyph, PrivacyGlyph, MemberGlyph] as const;

// 読了バッジ内のチェックマーク。
function ReadBadgeCheck() {
    return (
        <svg aria-hidden="true" viewBox="0 0 24 24">
            <path
                d="M20 6 9 17l-5-5"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="3"
            />
        </svg>
    );
}

// 同意チェックボックスのカスタムボックス内に表示するチェックマーク。
function ConsentCheckIcon() {
    return (
        <svg aria-hidden="true" className="terms-row-check" viewBox="0 0 24 24">
            <path
                d="M20 6 9 17l-5-5"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="3.5"
            />
        </svg>
    );
}

export function ConsentStep({
    disclaimersAccepted,
    onToggleDisclaimers,
    onBack,
    onNext,
}: {
    readonly disclaimersAccepted: boolean;
    readonly onToggleDisclaimers: (checked: boolean) => void;
    readonly onBack: () => void;
    readonly onNext: () => void;
}) {
    const t = useTranslations("register.wizard.consent");
    const tCommon = useTranslations("register.wizard.common");

    // 規約全文を最後まで読んだかどうか。読了バッジ／フェードの見た目のみに使い、
    // Next の活性条件には影響しない。
    const [docRead, setDocRead] = useState(false);
    const docRef = useRef<HTMLDivElement>(null);

    // 全文がスクロールせず収まる（背の高い画面・短い言語など）場合は、最初から
    // 読了扱いにしてフェードが残り続けないようにする。
    useEffect(() => {
        const el = docRef.current;
        if (el !== null && el.scrollHeight - el.clientHeight <= 8) {
            setDocRead(true);
        }
    }, []);

    function handleDocScroll(event: UIEvent<HTMLDivElement>) {
        if (docRead) {
            return;
        }
        const el = event.currentTarget;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) {
            setDocRead(true);
        }
    }

    return (
        <section
            aria-labelledby="wizard-consent-title"
            className="wizard-step-content wizard-consent"
        >
            <header className="wizard-heading">
                <p className="eyebrow">{t("eyebrow")}</p>
                <h1 className="wizard-title" id="wizard-consent-title">
                    {t("title")}
                </h1>
                <p className="wizard-lead">{t("lead")}</p>
            </header>

            {/* 01 · 平易な要約 */}
            <section aria-labelledby="consent-summary-label" className="consent-section">
                <p className="consent-section-head">
                    <span aria-hidden="true" className="consent-section-no" />
                    <span className="consent-section-label" id="consent-summary-label">
                        {t("plainLanguageLabel")}
                    </span>
                </p>
                <div className="consent-summary-grid">
                    {summaryKeys.map((key, index) => {
                        const Glyph = summaryGlyphs[index] ?? MemberGlyph;
                        return (
                            <div className="consent-summary-card" key={key}>
                                <span aria-hidden="true" className="consent-summary-icon">
                                    <Glyph />
                                </span>
                                <p className="consent-summary-title">{t(`summary.${key}.title`)}</p>
                                <p className="consent-summary-body">{t(`summary.${key}.body`)}</p>
                            </div>
                        );
                    })}
                </div>
            </section>

            {/* 02 · 規約全文（読了で badge/fade が切り替わるが gating には無関係） */}
            <section aria-labelledby="consent-doc-label" className="consent-section">
                <p className="consent-section-head">
                    <span aria-hidden="true" className="consent-section-no" />
                    <span className="consent-section-label" id="consent-doc-label">
                        {t("fullAgreementLabel")}
                    </span>
                    {docRead ? (
                        <span className="consent-doc-badge">
                            <ReadBadgeCheck />
                            {t("readToEnd")}
                        </span>
                    ) : (
                        <span className="consent-doc-meta">
                            {t("agreementMeta", { version: MEMBERSHIP_TERMS_VERSION })}
                        </span>
                    )}
                </p>
                <div className="consent-doc">
                    <div className="consent-doc-scroll" onScroll={handleDocScroll} ref={docRef}>
                        {clauseKeys.map((key) => (
                            <div className="consent-clause" key={key}>
                                <p className="consent-clause-head">
                                    <span className="consent-clause-no">{Number(key) + 1}</span>
                                    <span className="consent-clause-heading">
                                        {t(`clauses.${key}.heading`)}
                                    </span>
                                </p>
                                <p className="consent-clause-body">{t(`clauses.${key}.body`)}</p>
                            </div>
                        ))}
                        <p className="consent-doc-end">
                            {t("agreementEnd", { version: MEMBERSHIP_TERMS_VERSION })}
                        </p>
                    </div>
                    <div
                        aria-hidden="true"
                        className={`consent-doc-fade${docRead ? " is-hidden" : ""}`}
                    />
                </div>
            </section>

            {/* 03 · 同意。単一の「同意」チェックで Next を gating する挙動は不変。 */}
            <section aria-labelledby="consent-agree-label" className="consent-section">
                <p className="consent-section-head">
                    <span aria-hidden="true" className="consent-section-no" />
                    <span className="consent-section-label" id="consent-agree-label">
                        {t("consentLabel")}
                    </span>
                </p>
                <div className="terms-list">
                    <label className="terms-row">
                        <input
                            checked={disclaimersAccepted}
                            id="disclaimers-agree-all"
                            type="checkbox"
                            onChange={(e) => {
                                onToggleDisclaimers(e.target.checked);
                            }}
                        />
                        <span aria-hidden="true" className="terms-row-box">
                            <ConsentCheckIcon />
                        </span>
                        <span className="terms-row-text">
                            <span className="terms-row-label">{t("agreeLabel")}</span>
                            <span className="terms-row-detail">{t("agreeDetail")}</span>
                        </span>
                    </label>
                </div>
            </section>

            <div className="wizard-cta-bar">
                <button className="btn btn-ghost btn-lg" onClick={onBack} type="button">
                    {tCommon("back")}
                </button>
                <button
                    className="btn btn-primary btn-lg wizard-cta"
                    disabled={!disclaimersAccepted}
                    onClick={onNext}
                    type="button"
                >
                    {t("continueCta")}
                </button>
            </div>
            {disclaimersAccepted ? null : (
                <p className="wizard-cta-hint" role="note">
                    {t("gateHint")}
                </p>
            )}
        </section>
    );
}
