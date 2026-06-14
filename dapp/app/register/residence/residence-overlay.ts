import {
    h3HexToDecimal,
    residenceCellBoundary,
    type LatLng,
} from "./h3-geo";
import type { ResidenceCellClass } from "./h3-cell-classifier";

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export type OverlayCellKind = "selectable" | "disabled" | "selected" | "pending";

export interface OverlayCell {
    readonly hex: string;
    readonly decimal: string;
    readonly boundary: LatLng[];
    readonly kind: OverlayCellKind;
}

export interface BuildOverlayCellsInput {
    readonly viewportCellsHex: readonly string[];
    readonly classifications: ReadonlyMap<string, ResidenceCellClass>;
    readonly selectedDecimal: string | null;
}

export interface ResidenceSelectionState {
    readonly selectedDecimal: string | null;
}

export interface SelectResidenceCellResult {
    readonly state: ResidenceSelectionState;
    readonly rejected: boolean;
    readonly message?: string;
}

// ---------------------------------------------------------------------------
// 内部ヘルパー: セル種別の決定
// ---------------------------------------------------------------------------

/**
 * 単一セルの OverlayCellKind を決定する。
 * 選択済みセルは分類に関わらず "selected" が優先される。
 */
function resolveKind(
    decimal: string,
    selectedDecimal: string | null,
    classification: ResidenceCellClass | undefined,
): OverlayCellKind {
    if (decimal === selectedDecimal) {
        return "selected";
    }
    if (classification === "water") {
        return "disabled";
    }
    if (classification === "land" || classification === "unknown") {
        return "selectable";
    }
    // undefined（未分類）
    return "pending";
}

// ---------------------------------------------------------------------------
// buildOverlayCells
// ---------------------------------------------------------------------------

/**
 * ビューポート内の各 H3 セルに対して OverlayCell を組み立てる。
 *
 * - selectedDecimal と一致するセルは "selected"（他の分類より優先）
 * - water → "disabled"
 * - land / unknown → "selectable"（unknown は degrade として選択許可）
 * - undefined（未分類）→ "pending"
 * 入力順を保持した配列を返す。
 */
export function buildOverlayCells(input: BuildOverlayCellsInput): OverlayCell[] {
    const { viewportCellsHex, classifications, selectedDecimal } = input;
    return viewportCellsHex.map((hex) => {
        const decimal = h3HexToDecimal(hex);
        const boundary = residenceCellBoundary(hex);
        const classification = classifications.get(decimal);
        const kind = resolveKind(decimal, selectedDecimal, classification);
        return { hex, decimal, boundary, kind };
    });
}

// ---------------------------------------------------------------------------
// selectResidenceCell
// ---------------------------------------------------------------------------

/**
 * セルクリック時の選択状態を計算する。
 *
 * - water: 選択を拒否（rejected: true、state 不変）
 * - land / unknown: 選択を更新
 * - undefined（pending）: 海と証明できないため楽観的に選択を許可
 * 入力 state は変更しない（immutable）。
 */
export function selectResidenceCell(
    state: ResidenceSelectionState,
    clickedDecimal: string,
    classification: ResidenceCellClass | undefined,
): SelectResidenceCellResult {
    if (classification === "water") {
        return {
            state,
            rejected: true,
            message: "海上などのセルは居住地として選択できません。",
        };
    }
    return {
        state: { selectedDecimal: clickedDecimal },
        rejected: false,
    };
}
