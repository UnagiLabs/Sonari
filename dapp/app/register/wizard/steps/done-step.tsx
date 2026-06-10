"use client";

import { useTranslations } from "next-intl";
import { h3DecimalToHex } from "../../residence/h3-geo";

interface DoneStepProps {
    readonly selectedCellDecimal: string | null;
    readonly identityVerified: boolean;
}

export function DoneStep({ selectedCellDecimal, identityVerified }: DoneStepProps) {
    const t = useTranslations("register.wizard.done");
    const tCommon = useTranslations("register.wizard.common");

    return (
        <section aria-labelledby="wizard-done-title" className="wizard-step-content">
            <header className="wizard-heading">
                <div className="eyebrow">{t("eyebrow")}</div>
                <h1 className="wizard-title" id="wizard-done-title">
                    {t("title")}
                </h1>
                <p className="wizard-lead">{t("lead")}</p>
            </header>

            <div className="wizard-card wizard-summary-card">
                <div className="wizard-sbt-row">
                    <span>{t("summary.membership")}</span>
                    <strong>
                        {t("summary.membershipPending")}
                        <span className="tag tag-neutral wizard-summary-tag">
                            {tCommon("comingSoon")}
                        </span>
                    </strong>
                </div>
                <div className="wizard-sbt-row">
                    <span>{t("summary.residence")}</span>
                    <strong className="mono-value">
                        {selectedCellDecimal === null
                            ? t("summary.residenceEmpty")
                            : h3DecimalToHex(selectedCellDecimal)}
                    </strong>
                </div>
                <div className="wizard-sbt-row">
                    <span>{t("summary.identity")}</span>
                    <strong>
                        {identityVerified
                            ? t("summary.identityVerified")
                            : t("summary.identitySkipped")}
                    </strong>
                </div>
            </div>

            <div className="field-note" role="note">
                <small>{t("finalizeComingSoon")}</small>
            </div>

            <div className="wizard-cta-bar">
                <a className="btn btn-ghost btn-lg" href="/">
                    {t("homeCta")}
                </a>
                <a className="btn btn-primary btn-lg wizard-cta" href="/dashboard">
                    {t("dashboardCta")}
                </a>
            </div>
        </section>
    );
}
