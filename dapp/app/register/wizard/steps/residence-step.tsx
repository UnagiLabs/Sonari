"use client";

import { useTranslations } from "next-intl";
import { ResidenceCellPicker } from "../../residence/residence-cell-picker";
import type { ResidenceSaveErrorCode } from "../residence-save";

interface ResidenceStepProps {
    readonly accepted: readonly boolean[];
    readonly canContinue: boolean;
    readonly saveError: ResidenceSaveErrorCode | null;
    readonly onToggle: (index: number, checked: boolean) => void;
    readonly onCellSelectionChange: (decimal: string | null) => void;
    readonly onBack: () => void;
    readonly onNext: () => void;
}

export function ResidenceStep({
    accepted,
    canContinue,
    saveError,
    onToggle,
    onCellSelectionChange,
    onBack,
    onNext,
}: ResidenceStepProps) {
    const t = useTranslations("register.wizard.residence");
    const tCommon = useTranslations("register.wizard.common");

    function saveErrorMessage(): string | null {
        if (saveError === "cell_not_selected") return t("saveError.cellNotSelected");
        if (saveError === "invalid_cell") return t("saveError.invalidCell");
        return null;
    }

    const errorMessage = saveErrorMessage();

    return (
        <section aria-labelledby="wizard-residence-title" className="wizard-step-content">
            <header className="wizard-heading">
                <div className="eyebrow">{t("eyebrow")}</div>
                <h1 className="wizard-title" id="wizard-residence-title">
                    {t("title")}
                </h1>
                <p className="wizard-lead">{t("lead")}</p>
            </header>

            <div className="residence-step-stage">
                {/* 地図＋オーバーレイ（背景層） */}
                <ResidenceCellPicker onSelectionChange={onCellSelectionChange} />

                {/* 確定パネル（前景層）: チェックボックス・エラー・CTA */}
                <div className="residence-action-panel">
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

                    {errorMessage !== null ? (
                        <div className="field-note" role="alert">
                            <small>{errorMessage}</small>
                        </div>
                    ) : null}

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
                </div>
            </div>
        </section>
    );
}
