import {
    type LatLng,
    type ViewportBounds,
    residenceCellBoundary,
} from "../../register/residence/h3-geo";
import { parseHomeCell } from "../../mypage/home-cell";
import { type AffectedCell } from "./affected-cells";

// ---------------------------------------------------------------------------
// 上限定数
// ---------------------------------------------------------------------------

/**
 * 1回の描画で扱う被災セルの上限。極端な俯瞰でもポリゴン数を抑えるためのガード。
 *
 * セル境界は詳細確認用に限定し、俯瞰時は band-colored overlay を使う。
 */
export const MAX_AFFECTED_VIEWPORT_CELLS = 50;

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

/**
 * 地図の表示モード。
 * - `"overview"`: 被災エリア全体を俯瞰表示（居住セル未指定・不正時）
 * - `"home"`:     ユーザーの居住セルを中心に表示（有効な res7 居住セルがある場合）
 */
export type AffectedAreaMapMode = "overview" | "home";

export type AffectedAreaLayerMode = "overview-overlay" | "cells";

export interface AffectedCellGeometry {
    readonly cell: AffectedCell;
    readonly boundary: readonly LatLng[];
    readonly bounds: ViewportBounds;
}

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
 * 各セルの境界 bbox を集約し、
 * lat の min → south / max → north、lng の min → west / max → east を返す。
 *
 * - 空配列の場合は `null`（呼び出し側が固定中心へフォールバックする前提）
 * - 純粋・決定的。地図 SDK には依存しない。
 */
function computeBoundaryBounds(boundary: readonly LatLng[]): ViewportBounds {
    let bounds: { north: number; south: number; east: number; west: number } | null = null;

    for (const { lat, lng } of boundary) {
        if (bounds === null) {
            bounds = { north: lat, south: lat, east: lng, west: lng };
            continue;
        }
        if (lat > bounds.north) bounds.north = lat;
        if (lat < bounds.south) bounds.south = lat;
        if (lng > bounds.east) bounds.east = lng;
        if (lng < bounds.west) bounds.west = lng;
    }

    if (bounds === null) {
        throw new Error("cell boundary must not be empty");
    }

    return bounds;
}

export function buildAffectedCellGeometries(
    cells: readonly AffectedCell[],
): AffectedCellGeometry[] {
    return cells.map((cell) => {
        const boundary = residenceCellBoundary(cell.hex);
        return {
            cell,
            boundary,
            bounds: computeBoundaryBounds(boundary),
        };
    });
}

export function computeAffectedAreaBounds(
    cells: readonly AffectedCellGeometry[],
): ViewportBounds | null {
    let bounds: ViewportBounds | null = null;

    for (const geometry of cells) {
        const cellBounds = geometry.bounds;
        if (bounds === null) {
            bounds = { ...cellBounds };
            continue;
        }
        if (cellBounds.north > bounds.north) bounds.north = cellBounds.north;
        if (cellBounds.south < bounds.south) bounds.south = cellBounds.south;
        if (cellBounds.east > bounds.east) bounds.east = cellBounds.east;
        if (cellBounds.west < bounds.west) bounds.west = cellBounds.west;
    }

    return bounds;
}

// ---------------------------------------------------------------------------
// viewport 絞り込み
// ---------------------------------------------------------------------------

/**
 * `selectVisibleCells` の入力パラメータ。
 */
export interface SelectVisibleCellsInput {
    /** 絞り込み対象の被災セル集合。 */
    readonly cells: readonly AffectedCellGeometry[];
    /** 表示中の地図範囲（矩形）。west <= east を前提とする（日付変更線跨ぎは非対応）。 */
    readonly bounds: ViewportBounds;
    /** 返却件数の上限。省略時は MAX_AFFECTED_VIEWPORT_CELLS。 */
    readonly limit?: number;
    /** 強調する居住セル（10進）。範囲外・cap 溢れでも必ず結果に含める。任意。 */
    readonly highlightedDecimal?: string | null;
}

/**
 * セル境界の bbox が bounds の矩形と交差するかを判定するヘルパー。
 *
 * 境界線上は含む（閉区間）。
 * 注: west <= east を前提とする。日付変更線を跨ぐ範囲は非対応（東北デモでは発生しない）。
 */
function intersectsBounds(cellBounds: ViewportBounds, bounds: ViewportBounds): boolean {
    return (
        cellBounds.south <= bounds.north &&
        cellBounds.north >= bounds.south &&
        cellBounds.west <= bounds.east &&
        cellBounds.east >= bounds.west
    );
}

/**
 * 被災セル集合のうち「セル境界 bbox が現在の viewport bounds と交差する」ものだけを返す純粋関数。
 *
 * 挙動:
 * 1. 各セル境界 bbox が bounds と交差するかを判定し、交差するセルを入力順で集める。
 * 2. 件数が limit を超えたら先頭 limit 件に cap する（決定的）。
 * 3. `highlightedDecimal` が cells に存在するセルを指す場合、
 *    cap 後の結果にそのセルが含まれていなければ末尾に追加する（最大 limit+1 件になりうる）。
 *    強調セルが消えると自宅が見えなくなるため、cap より優先する。
 * 4. 入力配列は破壊しない。
 *
 * 地図 SDK には依存しない純粋・決定的な関数。
 */
export function selectVisibleCells(input: SelectVisibleCellsInput): AffectedCell[] {
    const { cells, bounds, highlightedDecimal } = input;
    const limit = input.limit ?? MAX_AFFECTED_VIEWPORT_CELLS;

    // bounds 内のセルを入力順で収集する
    const inBounds: AffectedCell[] = [];
    for (const geometry of cells) {
        if (intersectsBounds(geometry.bounds, bounds)) {
            inBounds.push(geometry.cell);
        }
    }

    // 上限を超えたら先頭 limit 件に cap する
    const capped = inBounds.length <= limit ? inBounds : inBounds.slice(0, limit);

    // 強調セルの処理: 指定がなければスキップ
    if (!highlightedDecimal) {
        return capped;
    }

    // 強調セルが cells に存在するかを確認する（存在しない場合は無視）
    let highlightedCell: AffectedCell | null = null;
    for (const geometry of cells) {
        if (geometry.cell.decimal === highlightedDecimal) {
            highlightedCell = geometry.cell;
            break;
        }
    }
    if (highlightedCell === null) {
        return capped;
    }

    // 既に cap 済み結果に含まれていれば追加不要
    let alreadyIncluded = false;
    for (const cell of capped) {
        if (cell.decimal === highlightedDecimal) {
            alreadyIncluded = true;
            break;
        }
    }
    if (alreadyIncluded) {
        return capped;
    }

    // 含まれていなければ（bounds 外 or cap 溢れ）末尾に追加する
    return [...capped, highlightedCell];
}

export interface SelectAffectedAreaLayerModeInput {
    readonly cells: readonly AffectedCellGeometry[];
    readonly bounds: ViewportBounds;
    readonly threshold?: number;
}

export function selectAffectedAreaLayerMode(
    input: SelectAffectedAreaLayerModeInput,
): AffectedAreaLayerMode {
    const threshold = input.threshold ?? MAX_AFFECTED_VIEWPORT_CELLS;
    let visibleCount = 0;

    for (const geometry of input.cells) {
        if (!intersectsBounds(geometry.bounds, input.bounds)) {
            continue;
        }
        visibleCount += 1;
        if (visibleCount > threshold) {
            return "overview-overlay";
        }
    }

    return "cells";
}
