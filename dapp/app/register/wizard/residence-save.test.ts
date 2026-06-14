import { describe, expect, it } from "vitest";
import {
    createInitialWizardState,
    type WizardState,
} from "./wizard-steps";
import { saveResidenceSelection } from "./residence-save";

// res7 の有効な H3 セル（10進）
const VALID_CELL = "608533827635118079";

function stateWith(overrides: Partial<WizardState>): WizardState {
    return { ...createInitialWizardState(), ...overrides };
}

const residenceDone = {
    selectedCellDecimal: VALID_CELL,
} as const;

// ---------------------------------------------------------------------------
// 正常系
// ---------------------------------------------------------------------------

describe("saveResidenceSelection - 正常系", () => {
    it("有効なセルで residenceSaved: true の新 state を返す", () => {
        const state = stateWith({ ...residenceDone });
        const result = saveResidenceSelection(state);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.state.residenceSaved).toBe(true);
            expect(result.state.selectedCellDecimal).toBe(VALID_CELL);
        }
    });

    it("すでに residenceSaved: true の state でも成功する", () => {
        const state = stateWith({ ...residenceDone, residenceSaved: true });
        const result = saveResidenceSelection(state);
        expect(result.ok).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// エラー系
// ---------------------------------------------------------------------------

describe("saveResidenceSelection - エラー系", () => {
    it("selectedCellDecimal が null のとき cell_not_selected エラーを返す", () => {
        const state = stateWith({ selectedCellDecimal: null });
        const result = saveResidenceSelection(state);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errorCode).toBe("cell_not_selected");
        }
    });

    it("selectedCellDecimal が無効な H3 セルのとき invalid_cell エラーを返す", () => {
        const state = stateWith({ selectedCellDecimal: "99999999999999999999" });
        const result = saveResidenceSelection(state);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errorCode).toBe("invalid_cell");
        }
    });

    it("selectedCellDecimal が res7 でない有効な H3 セルのとき invalid_cell エラーを返す", () => {
        // res8 の有効セル（10進）: 同じ座標の res8 セル
        const res8Cell = "613177787908448255";
        const state = stateWith({ selectedCellDecimal: res8Cell });
        const result = saveResidenceSelection(state);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errorCode).toBe("invalid_cell");
        }
    });
});

// ---------------------------------------------------------------------------
// イミュータブル
// ---------------------------------------------------------------------------

describe("saveResidenceSelection - イミュータブル", () => {
    it("入力 state を変更しない", () => {
        const state = stateWith({ ...residenceDone });
        const before = { ...state };
        saveResidenceSelection(state);
        expect(state).toEqual(before);
    });

    it("成功時の新 state は元 state と異なるオブジェクト", () => {
        const state = stateWith({ ...residenceDone });
        const result = saveResidenceSelection(state);
        if (result.ok) {
            expect(result.state).not.toBe(state);
        }
    });

    it("成功時の新 state は residenceSaved 以外のフィールドを保持する", () => {
        const state = stateWith({ ...residenceDone, membershipIssued: true, identityVerified: true });
        const result = saveResidenceSelection(state);
        if (result.ok) {
            expect(result.state.membershipIssued).toBe(true);
            expect(result.state.identityVerified).toBe(true);
            expect(result.state.selectedCellDecimal).toBe(VALID_CELL);
        }
    });
});
