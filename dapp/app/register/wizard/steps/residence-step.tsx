"use client";

import { useTranslations } from "next-intl";
import { ResidenceCellPicker } from "../../residence/residence-cell-picker";
import type { ResidenceSaveErrorCode } from "../residence-save";

interface ResidenceStepProps {
    readonly canContinue: boolean;
    /** true のとき residence ステップがアクティブ。contained な専用ワイドレイアウト modifier を付与する。 */
    readonly active?: boolean;
    readonly saveError: ResidenceSaveErrorCode | null;
    readonly onCellSelectionChange: (decimal: string | null) => void;
    readonly onBack: () => void;
    readonly onNext: () => void;
}

export function ResidenceStep({
    canContinue,
    active = false,
    saveError,
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

    const sectionClassName = active
        ? "wizard-step-content wizard-step-content--residence"
        : "wizard-step-content";

    return (
        <section aria-labelledby="wizard-residence-title" className={sectionClassName}>
            <header className="wizard-heading">
                <h1 className="wizard-title" id="wizard-residence-title">
                    {t("title")}
                </h1>
                <p className="wizard-lead">{t("lead")}</p>
            </header>

            {/* 地図＋左レール（検索・選択中エリア・凡例・プライバシー注記） */}
            <ResidenceCellPicker onSelectionChange={onCellSelectionChange} />

            {/* 確定操作: エラー・CTA・ヒントを contained 幅の下部に通常フローで配置 */}
            <div className="residence-cta">
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
        </section>
    );
}
