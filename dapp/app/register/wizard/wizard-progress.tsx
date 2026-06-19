"use client";

import { useTranslations } from "next-intl";
import {
    clampStepForState,
    stepIndex,
    WIZARD_STEPS,
    type WizardState,
    type WizardStepId,
} from "./wizard-steps";

interface WizardProgressProps {
    readonly active: WizardStepId;
    readonly state: WizardState;
    readonly onNavigate: (step: WizardStepId) => void;
}

// Apple 風の進捗ドット。到達済み・到達可能なステップへはクリックで移動できる。
// まだ条件を満たしていない先のステップは disabled で gating する。
export function WizardProgress({ active, state, onNavigate }: WizardProgressProps) {
    const t = useTranslations("register.wizard.progress");
    const activeIndex = stepIndex(active);

    // 完了画面（done）は進捗ナビに出さない。実際の入力ステップ（5つ）だけを表示し、
    // カウントもそれに合わせる。done に到達したときは全ステップ完了として扱う。
    const progressSteps = WIZARD_STEPS.filter((step) => step !== "done");
    const total = progressSteps.length;
    const current = Math.min(activeIndex + 1, total);

    return (
        <nav aria-label={t("aria")} className="wizard-progress">
            <p className="wizard-progress-count">{t("stepCount", { current, total })}</p>
            <ol className="wizard-progress-track">
                {progressSteps.map((step) => {
                    const index = stepIndex(step);
                    const isReachable = clampStepForState(state, step) === step;
                    const status =
                        step === active ? "current" : index < activeIndex ? "done" : "upcoming";
                    return (
                        <li className={`wizard-progress-item ${status}`} key={step}>
                            <button
                                aria-current={step === active ? "step" : undefined}
                                className="wizard-progress-dot-button"
                                disabled={!isReachable}
                                onClick={() => onNavigate(step)}
                                type="button"
                            >
                                <span aria-hidden="true" className="wizard-progress-dot" />
                                <span className="wizard-progress-label">{t(`steps.${step}`)}</span>
                                {step === "identity" ? (
                                    <span className="wizard-progress-optional">
                                        {t("optionalTag")}
                                    </span>
                                ) : null}
                            </button>
                        </li>
                    );
                })}
            </ol>
        </nav>
    );
}
