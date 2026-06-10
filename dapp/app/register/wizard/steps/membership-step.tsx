"use client";

import { useTranslations } from "next-intl";

interface MembershipStepProps {
    readonly accepted: readonly boolean[];
    readonly canContinue: boolean;
    readonly onToggle: (index: number, checked: boolean) => void;
    readonly onBack: () => void;
    readonly onNext: () => void;
}

export function MembershipStep({
    accepted,
    canContinue,
    onToggle,
    onBack,
    onNext,
}: MembershipStepProps) {
    const t = useTranslations("register.wizard.membership");
    const tCommon = useTranslations("register.wizard.common");

    return (
        <section aria-labelledby="wizard-membership-title" className="wizard-step-content">
            <header className="wizard-heading">
                <div className="eyebrow">{t("eyebrow")}</div>
                <h1 className="wizard-title" id="wizard-membership-title">
                    {t("title")}
                </h1>
                <p className="wizard-lead">{t("lead")}</p>
            </header>

            <div className="wizard-card wizard-sbt-card">
                <div className="wizard-sbt-row">
                    <span>{t("card.objectType")}</span>
                    <strong>{t("card.objectTypeValue")}</strong>
                </div>
                <div className="wizard-sbt-row">
                    <span>{t("card.owner")}</span>
                    <strong>{t("card.ownerPlaceholder")}</strong>
                </div>
                <div className="wizard-sbt-row">
                    <span>{t("card.transfer")}</span>
                    <strong>{t("card.transferValue")}</strong>
                </div>
                <div className="wizard-sbt-row">
                    <span>{t("card.status")}</span>
                    <strong>{t("card.statusValue")}</strong>
                </div>
            </div>

            <fieldset className="control-group">
                <legend>{t("statementsLegend")}</legend>
                <div className="terms-list">
                    {accepted.map((checked, index) => (
                        <label
                            className="terms-row"
                            // 固定長の承諾フラグ配列なので index キーで安定する。
                            // biome-ignore lint/suspicious/noArrayIndexKey: 配列は固定長・並べ替えなし
                            key={index}
                        >
                            <input
                                checked={checked}
                                name="membershipTerms"
                                onChange={(event) => onToggle(index, event.target.checked)}
                                type="checkbox"
                            />
                            <span>{t(`statements.${index}`)}</span>
                        </label>
                    ))}
                </div>
            </fieldset>

            <div className="field-note" role="note">
                <strong>
                    {t("issueButton")} — {tCommon("comingSoon")}
                </strong>
                <small>{t("issueComingSoon")}</small>
            </div>

            <div className="wizard-cta-bar">
                <button className="btn btn-ghost btn-lg" onClick={onBack} type="button">
                    {tCommon("back")}
                </button>
                <button
                    className="btn btn-primary btn-lg wizard-cta"
                    disabled={!canContinue}
                    onClick={onNext}
                    type="button"
                >
                    {tCommon("next")}
                </button>
            </div>
            {!canContinue ? (
                <p className="wizard-cta-hint" role="note">
                    {t("nextHint")}
                </p>
            ) : null}
        </section>
    );
}
