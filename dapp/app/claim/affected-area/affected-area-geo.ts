import { type ViewportBounds, residenceCellCenter } from "../../register/residence/h3-geo";
import { parseHomeCell } from "../../mypage/home-cell";
import { type AffectedCell } from "./affected-cells";

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

/**
 * 地図の表示モード。
 * - `"overview"`: 被災エリア全体を俯瞰表示（居住セル未指定・不正時）
 * - `"home"`:     ユーザーの居住セルを中心に表示（有効な res7 居住セルがある場合）
 */
export type AffectedAreaMapMode = "overview" | "home";

// ---------------------------------------------------------------------------
// モード判定
// ---------------------------------------------------------------------------

/**
 * 居住セル（10進文字列）の有無でモードを決定する純粋関数。
 *
 * 有効な res7 H3 セルであれば `"home"` を返す。
 * null / undefined / 空文字 / 不正値 / 解像度違いは `"overview"` にフォールバックする。
 *
 * 妥当性検証は `parseHomeCell` を再利用する（`parseH3Index` による res7 チェック込み）。
 */
export function selectMapMode(
    residenceCellDecimal: string | null | undefined,
): AffectedAreaMapMode {
    if (!residenceCellDecimal) {
        return "overview";
    }
    return parseHomeCell(residenceCellDecimal) !== null ? "home" : "overview";
}

// ---------------------------------------------------------------------------
// 俯瞰モード用: 被災エリア全体範囲算出
// ---------------------------------------------------------------------------

/**
 * 被災セル集合から、地図を合わせるための境界矩形（南北東西）を算出する純粋関数。
 *
 * 各セルの中心座標（`residenceCellCenter`）を集約し、
 * lat の min → south / max → north、lng の min → west / max → east を返す。
 *
 * - 空配列の場合は `null`（呼び出し側が固定中心へフォールバックする前提）
 * - 1件の場合は north===south、east===west の退化した bounds を返す（null ではない）
 * - 純粋・決定的。地図 SDK には依存しない。
 */
export function computeAffectedAreaBounds(
    cells: readonly AffectedCell[],
): ViewportBounds | null {
    // 添字アクセスを避け、最初のセルで初期化してから残りを集約する。
    // 空配列ならループに入らず null のまま返る（固定中心へフォールバックする前提）。
    let bounds: { north: number; south: number; east: number; west: number } | null = null;

    for (const cell of cells) {
        const { lat, lng } = residenceCellCenter(cell.hex);
        if (bounds === null) {
            bounds = { north: lat, south: lat, east: lng, west: lng };
            continue;
        }
        if (lat > bounds.north) bounds.north = lat;
        if (lat < bounds.south) bounds.south = lat;
        if (lng > bounds.east) bounds.east = lng;
        if (lng < bounds.west) bounds.west = lng;
    }

    return bounds;
}
