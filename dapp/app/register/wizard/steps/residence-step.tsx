"use client";

import { useTranslations } from "next-intl";
import { ResidenceCellPicker } from "../../residence/residence-cell-picker";

interface ResidenceStepProps {
    readonly accepted: readonly boolean[];
    readonly canContinue: boolean;
    readonly onToggle: (index: number, checked: boolean) => void;
    readonly onCellSelectionChange: (decimal: string | null) => void;
    readonly onBack: () => void;
    readonly onNext: () => void;
}

export function ResidenceStep({
    accepted,
    canContinue,
    onToggle,
    onCellSelectionChange,
    onBack,
    onNext,
}: ResidenceStepProps) {
    const t = useTranslations("register.wizard.residence");
    const tCommon = useTranslations("register.wizard.common");

    return (
        <section aria-labelledby="wizard-residence-title" className="wizard-step-content">
            <header className="wizard-heading">
                <div className="eyebrow">{t("eyebrow")}</div>
                <h1 className="wizard-title" id="wizard-residence-title">
                    {t("title")}
                </h1>
                <p className="wizard-lead">{t("lead")}</p>
            </header>

            <div className="wizard-card wizard-map-card">
                <ResidenceCellPicker onSelectionChange={onCellSelectionChange} />
            </div>

            <fieldset className="control-group">
                <legend>{t("statementsLegend")}</legend>
                <div className="terms-list">
                    {accepted.map((checked, index) => (
                        <label
                            className="terms-row"
                            // biome-ignore lint/suspicious/noArrayIndexKey: 配列は固定長・並べ替えなし
                            key={index}
                        >
                            <input
                                checked={checked}
                                name="residenceTerms"
                                onChange={(event) => onToggle(index, event.target.checked)}
                                type="checkbox"
                            />
                            <span>{t(`statements.${index}`)}</span>
                        </label>
                    ))}
                </div>
            </fieldset>

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
