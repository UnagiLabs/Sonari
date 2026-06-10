// 居住セル保存ロジック。UI から切り離した pure module。
// 正式な保存先はオンチェーン（membership SBT 発行時の register_member Move call）。
// ここでは wizard state に residenceSaved フラグを立て、sessionStorage への永続化を確定する。

import { parseH3Index } from "@sonari/proof-core";
import { RESIDENCE_H3_RESOLUTION } from "../residence/h3-geo";
import type { WizardState } from "./wizard-steps";

export type ResidenceSaveErrorCode = "cell_not_selected" | "invalid_cell";

export type ResidenceSaveResult =
    | { readonly ok: true; readonly state: WizardState }
    | { readonly ok: false; readonly errorCode: ResidenceSaveErrorCode };

/**
 * 選択中の H3 セルを検証し、residenceSaved フラグを立てた新しい state を返す。
 * 入力 state は変更しない（イミュータブル）。
 */
export function saveResidenceSelection(state: WizardState): ResidenceSaveResult {
    if (state.selectedCellDecimal === null) {
        return { ok: false, errorCode: "cell_not_selected" };
    }

    try {
        parseH3Index(state.selectedCellDecimal, RESIDENCE_H3_RESOLUTION);
    } catch {
        return { ok: false, errorCode: "invalid_cell" };
    }

    return {
        ok: true,
        state: { ...state, residenceSaved: true },
    };
}
