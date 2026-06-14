import { describe, expect, it } from "vitest";
import {
    canProceed,
    clampStepForState,
    createInitialWizardState,
    nextStep,
    parseStepParam,
    previousStep,
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
    selectedCellDecimal: "608533827635118079",
} as const;

const residenceDone = {
    selectedCellDecimal: "608533827635118079",
    residenceSaved: true,
} as const;

// ---------------------------------------------------------------------------
// WIZARD_STEPS / stepIndex
// ---------------------------------------------------------------------------

describe("WIZARD_STEPS", () => {
    it("welcome → consent → residence → membership → identity → done の順で6ステップ", () => {
        expect(WIZARD_STEPS).toEqual([
            "welcome",
            "consent",
            "residence",
            "membership",
            "identity",
            "done",
        ]);
    });

    it("stepIndex はステップ順の位置を返す", () => {
        expect(stepIndex("welcome")).toBe(0);
        expect(stepIndex("consent")).toBe(1);
        expect(stepIndex("done")).toBe(5);
    });
});

// ---------------------------------------------------------------------------
// parseStepParam
// ---------------------------------------------------------------------------

describe("parseStepParam", () => {
    it("正しいステップ ID はそのまま返す", () => {
        expect(parseStepParam("consent")).toBe("consent");
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
// createInitialWizardState
// ---------------------------------------------------------------------------

describe("createInitialWizardState", () => {
    it("disclaimersAccepted が false で初期化される", () => {
        expect(createInitialWizardState().disclaimersAccepted).toBe(false);
    });

    it("membershipIssued は false で初期化される", () => {
        expect(createInitialWizardState().membershipIssued).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// canProceed
// ---------------------------------------------------------------------------

describe("canProceed", () => {
    it("welcome は常に前進できる（ウォレット接続は UI 側で gating）", () => {
        expect(canProceed(createInitialWizardState(), "welcome")).toBe(true);
        expect(canProceed(stateWith({ disclaimersAccepted: true }), "welcome")).toBe(true);
    });

    it("consent は disclaimersAccepted が false なら前進不可", () => {
        expect(canProceed(createInitialWizardState(), "consent")).toBe(false);
    });

    it("consent は disclaimersAccepted が true なら前進可", () => {
        expect(canProceed(stateWith({ disclaimersAccepted: true }), "consent")).toBe(true);
    });

    it("membership はセル選択・発行・保存で前進できる（配列同意なし）", () => {
        expect(canProceed(createInitialWizardState(), "membership")).toBe(false);
        expect(
            canProceed(stateWith({ ...membershipDone }), "membership"),
        ).toBe(true);
    });

    it("membership は residenceSaved が false なら前進できない", () => {
        const state = stateWith({ ...membershipDone, residenceSaved: false });
        expect(canProceed(state, "membership")).toBe(false);
    });

    it("membership は membershipIssued が false なら前進できない", () => {
        const state = stateWith({ ...membershipDone, membershipIssued: false });
        expect(canProceed(state, "membership")).toBe(false);
    });

    it("membership は selectedCellDecimal が null なら前進できない", () => {
        const state = stateWith({ ...membershipDone, selectedCellDecimal: null });
        expect(canProceed(state, "membership")).toBe(false);
    });

    it("residence はセル選択と residenceSaved の2つが必要（配列同意なし）", () => {
        expect(canProceed(stateWith({ ...residenceDone }), "residence")).toBe(true);
        expect(
            canProceed(
                stateWith({ ...residenceDone, selectedCellDecimal: null }),
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
    it("未同意（disclaimersAccepted: false）で done を要求しても consent を返す", () => {
        expect(clampStepForState(createInitialWizardState(), "done")).toBe("consent");
    });

    it("未同意（disclaimersAccepted: false）で membership を要求しても consent を返す", () => {
        expect(clampStepForState(createInitialWizardState(), "membership")).toBe("consent");
    });

    it("welcome は未同意でも到達でき、gating は consent から始まる", () => {
        expect(clampStepForState(createInitialWizardState(), "welcome")).toBe("welcome");
        expect(clampStepForState(createInitialWizardState(), "consent")).toBe("consent");
    });

    it("同意済みでセル未選択なら residence で止まる", () => {
        const state = stateWith({ disclaimersAccepted: true });
        expect(clampStepForState(state, "done")).toBe("residence");
        expect(clampStepForState(state, "membership")).toBe("residence");
    });

    it("セル選択・承諾済みでも residenceSaved: false なら membership に到達できない（URL 直リンク対策）", () => {
        const state = stateWith({ disclaimersAccepted: true, ...residenceDone, residenceSaved: false });
        expect(clampStepForState(state, "membership")).toBe("residence");
        expect(clampStepForState(state, "identity")).toBe("residence");
        expect(clampStepForState(state, "done")).toBe("residence");
    });

    it("同意済み＋residence 完了済みでも membership 未発行なら membership で止まる", () => {
        const state = stateWith({ disclaimersAccepted: true, ...residenceDone });
        expect(clampStepForState(state, "membership")).toBe("membership");
        expect(clampStepForState(state, "identity")).toBe("membership");
        expect(clampStepForState(state, "done")).toBe("membership");
    });

    it("membership と residence が完了済みなら identity / done に到達できる", () => {
        const state = stateWith({ disclaimersAccepted: true, ...membershipDone, ...residenceDone });
        expect(clampStepForState(state, "identity")).toBe("identity");
        expect(clampStepForState(state, "done")).toBe("done");
    });

    it("到達可能なステップへの後退要求はそのまま通る", () => {
        const state = stateWith({ disclaimersAccepted: true, ...membershipDone, ...residenceDone });
        expect(clampStepForState(state, "welcome")).toBe("welcome");
        expect(clampStepForState(state, "membership")).toBe("membership");
    });
});

// ---------------------------------------------------------------------------
// nextStep / previousStep
// ---------------------------------------------------------------------------

describe("nextStep / previousStep", () => {
    it("nextStep は次のステップを返し、終端では null", () => {
        expect(nextStep("welcome")).toBe("consent");
        expect(nextStep("consent")).toBe("residence");
        expect(nextStep("residence")).toBe("membership");
        expect(nextStep("identity")).toBe("done");
        expect(nextStep("done")).toBeNull();
    });

    it("previousStep は前のステップを返し、先頭では null", () => {
        expect(previousStep("membership")).toBe("residence");
        expect(previousStep("residence")).toBe("consent");
        expect(previousStep("consent")).toBe("welcome");
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

