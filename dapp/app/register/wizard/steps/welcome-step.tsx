"use client";

import { useTranslations } from "next-intl";
import { WalletConnect } from "../../../wallet/wallet-connect";

const privacyKeys = [
    "walletAddress",
    "nickname",
    "addressSearch",
    "phoneEmail",
    "gpsHistory",
    "deviceInfo",
    "h3Cell",
] as const;

export function WelcomeStep({ onNext }: { readonly onNext: () => void }) {
    const t = useTranslations("register.wizard.welcome");

    return (
        <section aria-labelledby="wizard-welcome-title" className="wizard-step-content">
            <header className="wizard-heading">
                <div className="eyebrow">{t("eyebrow")}</div>
                <h1 className="wizard-title" id="wizard-welcome-title">
                    {t("title")}
                </h1>
                <p className="wizard-lead">{t("lead")}</p>
            </header>

            <div className="wizard-card wizard-wallet-card">
                <p className="muted">{t("walletHint")}</p>
                <WalletConnect />
            </div>

            <details className="wizard-details">
                <summary>{t("privacySummary")}</summary>
                <div className="privacy-list">
                    {privacyKeys.map((key) => (
                        <div className="privacy-row" key={key}>
                            <span>{t(`privacy.${key}.label`)}</span>
                            <strong>{t(`privacy.${key}.value`)}</strong>
                        </div>
                    ))}
                </div>
            </details>

            <div className="wizard-cta-bar">
                <button
                    className="btn btn-primary btn-lg wizard-cta"
                    onClick={onNext}
                    type="button"
                >
                    {t("cta")}
                </button>
            </div>
        </section>
    );
}
