"use client";

import { useTranslations } from "next-intl";

const residenceDisclaimerKeys = ["0", "1", "2"] as const;
const membershipDisclaimerKeys = ["0", "1", "2"] as const;

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

    return (
        <section aria-labelledby="wizard-consent-title" className="wizard-step-content">
            <header className="wizard-heading">
                <div className="eyebrow">{t("eyebrow")}</div>
                <h1 className="wizard-title" id="wizard-consent-title">
                    {t("title")}
                </h1>
                <p className="wizard-lead">{t("lead")}</p>
            </header>

            <div className="wizard-card">
                <div className="disclaimer-group">
                    <p className="disclaimer-group-title">{t("residenceTitle")}</p>
                    <ul className="disclaimer-list">
                        {residenceDisclaimerKeys.map((key) => (
                            <li key={key}>{t(`residence.${key}`)}</li>
                        ))}
                    </ul>
                </div>
                <div className="disclaimer-group">
                    <p className="disclaimer-group-title">{t("membershipTitle")}</p>
                    <ul className="disclaimer-list">
                        {membershipDisclaimerKeys.map((key) => (
                            <li key={key}>{t(`membership.${key}`)}</li>
                        ))}
                    </ul>
                </div>
                <div className="control-group">
                    <input
                        checked={disclaimersAccepted}
                        id="disclaimers-agree-all"
                        type="checkbox"
                        onChange={(e) => {
                            onToggleDisclaimers(e.target.checked);
                        }}
                    />
                    <label htmlFor="disclaimers-agree-all">{t("agreeAll")}</label>
                </div>
            </div>

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
                    {tCommon("next")}
                </button>
            </div>
        </section>
    );
}
