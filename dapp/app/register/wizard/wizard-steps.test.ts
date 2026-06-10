import { describe, expect, it } from "vitest";
import {
    canProceed,
    clampStepForState,
    createInitialWizardState,
    MEMBERSHIP_STATEMENT_COUNT,
    nextStep,
    parseStepParam,
    previousStep,
    RESIDENCE_STATEMENT_COUNT,
    slideDirection,
    stepIndex,
    WIZARD_STEPS,
    type WizardState,
} from "./wizard-steps";

// テスト用に各ゲートを満たした状態を組み立てるヘルパ。
function stateWith(overrides: Partial<WizardState>): WizardState {
    return { ...createInitialWizardState(), ...overrides };
}

const membershipDone = {
    membershipIssued: true,
    residenceSaved: true,
    membershipAccepted: Array.from({ length: MEMBERSHIP_STATEMENT_COUNT }, () => true),
} as const;

const residenceDone = {
    residenceAccepted: Array.from({ length: RESIDENCE_STATEMENT_COUNT }, () => true),
    selectedCellDecimal: "608533827635118079",
    residenceSaved: true,
} as const;

// ---------------------------------------------------------------------------
// WIZARD_STEPS / stepIndex
// ---------------------------------------------------------------------------

describe("WIZARD_STEPS", () => {
    it("welcome → residence → membership → identity → done の順で5ステップ", () => {
        expect(WIZARD_STEPS).toEqual(["welcome", "residence", "membership", "identity", "done"]);
    });

    it("stepIndex はステップ順の位置を返す", () => {
        expect(stepIndex("welcome")).toBe(0);
        expect(stepIndex("done")).toBe(4);
    });
});

// ---------------------------------------------------------------------------
// parseStepParam
// ---------------------------------------------------------------------------

describe("parseStepParam", () => {
    it("正しいステップ ID はそのまま返す", () => {
        expect(parseStepParam("residence")).toBe("residence");
        expect(parseStepParam("identity")).toBe("identity");
    });

    it("null / undefined / 空文字は welcome に落ちる", () => {
        expect(parseStepParam(null)).toBe("welcome");
        expect(parseStepParam(undefined)).toBe("welcome");
        expect(parseStepParam("")).toBe("welcome");
    });

    it("未知の値は welcome に落ちる", () => {
        expect(parseStepParam("pass")).toBe("welcome");
        expect(parseStepParam("step-2")).toBe("welcome");
    });
});

// ---------------------------------------------------------------------------
// canProceed
// ---------------------------------------------------------------------------

describe("canProceed", () => {
    it("welcome は常に前進できる", () => {
        expect(canProceed(createInitialWizardState(), "welcome")).toBe(true);
    });

    it("membership は全ステートメント承諾で前進できる", () => {
        expect(canProceed(createInitialWizardState(), "membership")).toBe(false);
        expect(canProceed(stateWith({ ...membershipDone }), "membership")).toBe(false);
        expect(
            canProceed(stateWith({ ...membershipDone, ...residenceDone }), "membership"),
        ).toBe(true);
    });

    it("membership は residenceSaved が false なら前進できない", () => {
        const state = stateWith({ ...membershipDone, ...residenceDone, residenceSaved: false });
        expect(canProceed(state, "membership")).toBe(false);
    });

    it("membership は1つでも未承諾なら前進できない", () => {
        const partial = stateWith({
            membershipAccepted: [true, true, false],
        });
        expect(canProceed(partial, "membership")).toBe(false);
    });

    it("residence はセル選択と全ステートメント承諾と residenceSaved の3つが必要", () => {
        expect(canProceed(stateWith({ ...residenceDone }), "residence")).toBe(true);
        expect(
            canProceed(
                stateWith({ ...residenceDone, selectedCellDecimal: null }),
                "residence",
            ),
        ).toBe(false);
        expect(
            canProceed(
                stateWith({ ...residenceDone, residenceAccepted: [true, false, true] }),
                "residence",
            ),
        ).toBe(false);
        expect(
            canProceed(
                stateWith({ ...residenceDone, residenceSaved: false }),
                "residence",
            ),
        ).toBe(false);
    });

    it("identity は任意ステップなので常に前進（スキップ）できる", () => {
        expect(canProceed(createInitialWizardState(), "identity")).toBe(true);
    });

    it("done は終端なので前進できない", () => {
        expect(canProceed(createInitialWizardState(), "done")).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// clampStepForState
// ---------------------------------------------------------------------------

describe("clampStepForState", () => {
    it("初期状態で done を要求しても residence までしか進めない", () => {
        expect(clampStepForState(createInitialWizardState(), "done")).toBe("residence");
    });

    it("セル選択・承諾済みでも residenceSaved: false なら membership に到達できない（URL 直リンク対策）", () => {
        const state = stateWith({ ...residenceDone, residenceSaved: false });
        expect(clampStepForState(state, "membership")).toBe("residence");
        expect(clampStepForState(state, "identity")).toBe("residence");
        expect(clampStepForState(state, "done")).toBe("residence");
    });

    it("residence 完了済みでも membership 未発行なら membership で止まる", () => {
        const state = stateWith({ ...residenceDone });
        expect(clampStepForState(state, "membership")).toBe("membership");
        expect(clampStepForState(state, "identity")).toBe("membership");
        expect(clampStepForState(state, "done")).toBe("membership");
    });

    it("membership と residence が完了済みなら identity / done に到達できる", () => {
        const state = stateWith({ ...membershipDone, ...residenceDone });
        expect(clampStepForState(state, "identity")).toBe("identity");
        expect(clampStepForState(state, "done")).toBe("done");
    });

    it("到達可能なステップへの後退要求はそのまま通る", () => {
        const state = stateWith({ ...membershipDone, ...residenceDone });
        expect(clampStepForState(state, "welcome")).toBe("welcome");
        expect(clampStepForState(state, "membership")).toBe("membership");
    });
});

// ---------------------------------------------------------------------------
// nextStep / previousStep
// ---------------------------------------------------------------------------

describe("nextStep / previousStep", () => {
    it("nextStep は次のステップを返し、終端では null", () => {
        expect(nextStep("welcome")).toBe("residence");
        expect(nextStep("residence")).toBe("membership");
        expect(nextStep("identity")).toBe("done");
        expect(nextStep("done")).toBeNull();
    });

    it("previousStep は前のステップを返し、先頭では null", () => {
        expect(previousStep("membership")).toBe("residence");
        expect(previousStep("residence")).toBe("welcome");
        expect(previousStep("welcome")).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// slideDirection
// ---------------------------------------------------------------------------

describe("slideDirection", () => {
    it("前進は 1、後退は -1、同一は 0", () => {
        expect(slideDirection("welcome", "membership")).toBe(1);
        expect(slideDirection("identity", "residence")).toBe(-1);
        expect(slideDirection("residence", "residence")).toBe(0);
    });
});
