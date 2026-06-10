// 登録ウィザードのステップ定義と進行ロジック。
// UI から切り離した pure module として保ち、unit test で仕様を固定する。

export const WIZARD_STEPS = ["welcome", "residence", "membership", "identity", "done"] as const;

export type WizardStepId = (typeof WIZARD_STEPS)[number];

export type WizardIdentityProvider = "kyc" | "world_id";

// membership / residence の承諾ステートメント数。文言は messages 側で管理し、
// ロジックは個数のみに依存させる。
export const MEMBERSHIP_STATEMENT_COUNT = 3;
export const RESIDENCE_STATEMENT_COUNT = 3;

export interface WizardState {
    /** membership SBT の発行完了フラグ */
    readonly membershipIssued: boolean;
    /** membership ステップの承諾フラグ（ステートメントごと） */
    readonly membershipAccepted: readonly boolean[];
    /** residence ステップの承諾フラグ（ステートメントごと） */
    readonly residenceAccepted: readonly boolean[];
    /** 選択中の H3 res7 セル（10進文字列）。未選択は null */
    readonly selectedCellDecimal: string | null;
    /** residence ステップで選択セルの保存を完了したか */
    readonly residenceSaved: boolean;
    /** identity ステップで選択中のプロバイダー */
    readonly identityProvider: WizardIdentityProvider;
    /** identity 検証が完了したか（スキップは false のまま done へ進める） */
    readonly identityVerified: boolean;
}

export function createInitialWizardState(): WizardState {
    return {
        membershipIssued: false,
        membershipAccepted: Array.from({ length: MEMBERSHIP_STATEMENT_COUNT }, () => false),
        residenceAccepted: Array.from({ length: RESIDENCE_STATEMENT_COUNT }, () => false),
        selectedCellDecimal: null,
        residenceSaved: false,
        identityProvider: "world_id",
        identityVerified: false,
    };
}

export function stepIndex(step: WizardStepId): number {
    return WIZARD_STEPS.indexOf(step);
}

/** `?step=` クエリ値をステップ ID へ解釈する。未知の値は welcome に落とす。 */
export function parseStepParam(value: string | null | undefined): WizardStepId {
    return (WIZARD_STEPS as readonly string[]).includes(value ?? "")
        ? (value as WizardStepId)
        : "welcome";
}

/** そのステップから次へ前進できるか（= ステップ完了条件を満たすか）。 */
export function canProceed(state: WizardState, step: WizardStepId): boolean {
    switch (step) {
        case "welcome":
            return true;
        case "residence":
            return (
                state.residenceAccepted.length === RESIDENCE_STATEMENT_COUNT &&
                state.residenceAccepted.every((accepted) => accepted) &&
                state.selectedCellDecimal !== null
            );
        case "membership":
            return (
                state.membershipIssued &&
                state.residenceSaved &&
                state.membershipAccepted.length === MEMBERSHIP_STATEMENT_COUNT &&
                state.membershipAccepted.every((accepted) => accepted) &&
                state.selectedCellDecimal !== null
            );
        case "identity":
            // 任意ステップ。検証してもスキップしても前進できる。
            return true;
        case "done":
            return false;
    }
}

/**
 * 直リンクや復元で要求されたステップを、現在の状態で到達可能な最深ステップに丸める。
 * welcome から順に canProceed を辿り、最初に完了条件を満たさないステップで止まる。
 */
export function clampStepForState(state: WizardState, requested: WizardStepId): WizardStepId {
    const requestedIndex = stepIndex(requested);
    for (const step of WIZARD_STEPS) {
        if (stepIndex(step) >= requestedIndex) {
            return requested;
        }
        if (!canProceed(state, step)) {
            return step;
        }
    }
    return requested;
}

export function nextStep(step: WizardStepId): WizardStepId | null {
    return WIZARD_STEPS[stepIndex(step) + 1] ?? null;
}

export function previousStep(step: WizardStepId): WizardStepId | null {
    return WIZARD_STEPS[stepIndex(step) - 1] ?? null;
}

/** ステップ遷移のスライド方向。前進 1 / 後退 -1 / 同一 0。 */
export function slideDirection(from: WizardStepId, to: WizardStepId): -1 | 0 | 1 {
    return Math.sign(stepIndex(to) - stepIndex(from)) as -1 | 0 | 1;
}
