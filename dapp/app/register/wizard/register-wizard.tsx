"use client";

import { useCurrentAccount } from "@mysten/dapp-kit-react";
import { domAnimation, LazyMotion, MotionConfig, m } from "motion/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ResidenceSaveErrorCode, saveResidenceSelection } from "./residence-save";
import { DoneStep } from "./steps/done-step";
import { IdentityStep } from "./steps/identity-step";
import { MembershipStep } from "./steps/membership-step";
import { ResidenceStep } from "./steps/residence-step";
import { WelcomeStep } from "./steps/welcome-step";
import { WizardProgress } from "./wizard-progress";
import {
    clampStepForState,
    createInitialWizardState,
    nextStep,
    parseStepParam,
    previousStep,
    RESIDENCE_STATEMENT_COUNT,
    stepIndex,
    WIZARD_STEPS,
    type WizardIdentityProvider,
    type WizardState,
    type WizardStepId,
} from "./wizard-steps";
import { deserializeWizardState, serializeWizardState, WIZARD_STORAGE_KEY } from "./wizard-storage";

// ステップ切替アニメーション。前進は右から、後退は左からスライドインする。
const SLIDE_OFFSET_PX = 48;
const stepTransition = { duration: 0.4, ease: [0.32, 0.72, 0, 1] } as const;

export function RegisterWizard() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const account = useCurrentAccount();

    const [state, setState] = useState<WizardState>(createInitialWizardState);
    const [residenceSaveError, setResidenceSaveError] = useState<ResidenceSaveErrorCode | null>(
        null,
    );
    // sessionStorage の復元はマウント後に行い、初回描画をサーバーと一致させる。
    const [hydrated, setHydrated] = useState(false);
    useEffect(() => {
        setState(deserializeWizardState(window.sessionStorage.getItem(WIZARD_STORAGE_KEY)));
        setHydrated(true);
    }, []);
    useEffect(() => {
        if (!hydrated) {
            return;
        }
        window.sessionStorage.setItem(WIZARD_STORAGE_KEY, serializeWizardState(state));
    }, [state, hydrated]);

    const previousWalletAddressRef = useRef<string | null>(null);
    useEffect(() => {
        const currentWalletAddress = account?.address ?? null;
        if (previousWalletAddressRef.current === currentWalletAddress) {
            return;
        }
        previousWalletAddressRef.current = currentWalletAddress;
        setState((current) =>
            current.membershipIssued ? { ...current, membershipIssued: false } : current,
        );
    }, [account?.address]);

    // URL の ?step= が信頼できる現在地。状態で到達できない深さは clamp する。
    const requestedStep = parseStepParam(searchParams.get("step"));
    const activeStep = clampStepForState(state, requestedStep);

    // clamp が起きたら URL も到達可能なステップへ正規化する（履歴は汚さない）。
    useEffect(() => {
        if (hydrated && activeStep !== requestedStep) {
            router.replace(`/register?step=${activeStep}`, { scroll: false });
        }
    }, [hydrated, activeStep, requestedStep, router]);

    // 一度表示したステップはマウントしたまま保持する（keep-mounted）。
    // Google Maps などの重い初期化がステップ往復で繰り返されないようにする。
    const [visitedSteps, setVisitedSteps] = useState<ReadonlySet<WizardStepId>>(
        () => new Set<WizardStepId>(),
    );
    useEffect(() => {
        setVisitedSteps((current) =>
            current.has(activeStep) ? current : new Set([...current, activeStep]),
        );
    }, [activeStep]);

    const goTo = useCallback(
        (step: WizardStepId) => {
            router.push(`/register?step=${step}`, { scroll: false });
        },
        [router],
    );
    const goNext = useCallback(() => {
        const next = nextStep(activeStep);
        if (next !== null) {
            goTo(next);
        }
    }, [activeStep, goTo]);
    const goBack = useCallback(() => {
        const previous = previousStep(activeStep);
        if (previous !== null) {
            goTo(previous);
        }
    }, [activeStep, goTo]);

    const handleMembershipToggle = useCallback((index: number, checked: boolean) => {
        setState((current) => ({
            ...current,
            membershipAccepted: current.membershipAccepted.map((value, position) =>
                position === index ? checked : value,
            ),
        }));
    }, []);
    const handleResidenceToggle = useCallback((index: number, checked: boolean) => {
        setState((current) => ({
            ...current,
            residenceAccepted: current.residenceAccepted.map((value, position) =>
                position === index ? checked : value,
            ),
        }));
    }, []);
    const handleMembershipIssued = useCallback(() => {
        setState((current) =>
            current.membershipIssued ? current : { ...current, membershipIssued: true },
        );
    }, []);
    // ResidenceCellPicker から安定参照で呼ばれるため useCallback で固定する。
    // セルが変わったら residenceSaved をリセットしてエラーをクリアする。
    const handleCellSelectionChange = useCallback((decimal: string | null) => {
        setState((current) => {
            if (current.selectedCellDecimal === decimal) {
                return current;
            }
            return { ...current, selectedCellDecimal: decimal, residenceSaved: false };
        });
        setResidenceSaveError(null);
    }, []);

    const handleResidenceNext = useCallback(() => {
        const result = saveResidenceSelection(state);
        if (result.ok) {
            setState(result.state);
            setResidenceSaveError(null);
            const next = nextStep("residence");
            if (next !== null) {
                goTo(next);
            }
        } else {
            setResidenceSaveError(result.errorCode);
        }
    }, [state, goTo]);
    const handleProviderChange = useCallback((provider: WizardIdentityProvider) => {
        setState((current) => ({ ...current, identityProvider: provider }));
    }, []);
    const handleIdentityVerified = useCallback(() => {
        setState((current) => ({ ...current, identityVerified: true }));
    }, []);

    function renderStep(step: WizardStepId) {
        switch (step) {
            case "welcome":
                return <WelcomeStep onNext={goNext} />;
            case "residence": {
                // Next ボタンは「保存前の準備完了条件」で制御する。
                // canProceed("residence") は residenceSaved も含むため、保存前のボタンが
                // 永続 disabled になる鶏卵問題を避けるため別途計算する。
                const residenceReadyToSave =
                    state.residenceAccepted.length === RESIDENCE_STATEMENT_COUNT &&
                    state.residenceAccepted.every(Boolean) &&
                    state.selectedCellDecimal !== null;
                return (
                    <ResidenceStep
                        accepted={state.residenceAccepted}
                        canContinue={residenceReadyToSave}
                        saveError={residenceSaveError}
                        onBack={goBack}
                        onCellSelectionChange={handleCellSelectionChange}
                        onNext={handleResidenceNext}
                        onToggle={handleResidenceToggle}
                    />
                );
            }
            case "membership":
                return (
                    <MembershipStep
                        accepted={state.membershipAccepted}
                        membershipIssued={state.membershipIssued}
                        onBack={goBack}
                        onIssued={handleMembershipIssued}
                        onNext={goNext}
                        onToggle={handleMembershipToggle}
                        selectedCellDecimal={state.selectedCellDecimal}
                    />
                );
            case "identity":
                return (
                    <IdentityStep
                        identityVerified={state.identityVerified}
                        onBack={goBack}
                        onFinish={goNext}
                        onProviderChange={handleProviderChange}
                        onVerified={handleIdentityVerified}
                        provider={state.identityProvider}
                    />
                );
            case "done":
                return (
                    <DoneStep
                        membershipIssued={state.membershipIssued}
                        identityVerified={state.identityVerified}
                        selectedCellDecimal={state.selectedCellDecimal}
                    />
                );
        }
    }

    return (
        <div className="wizard-shell">
            <WizardProgress active={activeStep} onNavigate={goTo} state={state} />
            <LazyMotion features={domAnimation} strict>
                <MotionConfig reducedMotion="user">
                    <div className="wizard-stage">
                        {WIZARD_STEPS.map((step) => {
                            if (step !== activeStep && !visitedSteps.has(step)) {
                                return null;
                            }
                            const isActive = step === activeStep;
                            // 非アクティブステップは進行方向に応じた側へ退避させる。
                            const exitOffset =
                                stepIndex(step) < stepIndex(activeStep)
                                    ? -SLIDE_OFFSET_PX
                                    : SLIDE_OFFSET_PX;
                            return (
                                <m.div
                                    animate={
                                        isActive
                                            ? { x: 0, opacity: 1, visibility: "visible" }
                                            : {
                                                  x: exitOffset,
                                                  opacity: 0,
                                                  transitionEnd: { visibility: "hidden" },
                                              }
                                    }
                                    aria-hidden={!isActive}
                                    className={`wizard-step${isActive ? "" : " wizard-step-inactive"}`}
                                    inert={!isActive || undefined}
                                    initial={false}
                                    key={step}
                                    transition={stepTransition}
                                >
                                    {renderStep(step)}
                                </m.div>
                            );
                        })}
                    </div>
                </MotionConfig>
            </LazyMotion>
        </div>
    );
}
