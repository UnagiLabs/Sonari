import { type ViewportBounds, residenceCellCenter } from "../../register/residence/h3-geo";
import { parseHomeCell } from "../../mypage/home-cell";
import { type AffectedCell } from "./affected-cells";

// ---------------------------------------------------------------------------
// 上限定数
// ---------------------------------------------------------------------------

/**
 * 1回の描画で扱う被災セルの上限。極端な俯瞰でもポリゴン数を抑えるためのガード。
 *
 * 被災セットは有限・ズーム非依存のため、residence-cell-picker の
 * MAX_VIEWPORT_CELLS=200 より大きめの 600 を採用。
 */
export const MAX_AFFECTED_VIEWPORT_CELLS = 600;

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

// ---------------------------------------------------------------------------
// viewport 絞り込み
// ---------------------------------------------------------------------------

/**
 * `selectVisibleCells` の入力パラメータ。
 */
export interface SelectVisibleCellsInput {
    /** 絞り込み対象の被災セル集合。 */
    readonly cells: readonly AffectedCell[];
    /** 表示中の地図範囲（矩形）。west <= east を前提とする（日付変更線跨ぎは非対応）。 */
    readonly bounds: ViewportBounds;
    /** 返却件数の上限。省略時は MAX_AFFECTED_VIEWPORT_CELLS。 */
    readonly limit?: number;
    /** 強調する居住セル（10進）。範囲外・cap 溢れでも必ず結果に含める。任意。 */
    readonly highlightedDecimal?: string | null;
}

/**
 * セル中心が bounds の矩形内に含まれるかを判定するヘルパー。
 *
 * 判定: lat <= north && lat >= south && lng <= east && lng >= west
 * 境界線上は含む（<=, >= の閉区間）。
 * 注: west <= east を前提とする。日付変更線を跨ぐ範囲は非対応（東北デモでは発生しない）。
 */
function isCenterInBounds(hex: string, bounds: ViewportBounds): boolean {
    const { lat, lng } = residenceCellCenter(hex);
    return (
        lat <= bounds.north &&
        lat >= bounds.south &&
        lng <= bounds.east &&
        lng >= bounds.west
    );
}

/**
 * 被災セル集合のうち「中心が現在の viewport bounds 内」のものだけを返す純粋関数。
 *
 * 挙動:
 * 1. 各セル中心が bounds 内かを判定し、内側のみ入力順で集める。
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
    for (const cell of cells) {
        if (isCenterInBounds(cell.hex, bounds)) {
            inBounds.push(cell);
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
    for (const cell of cells) {
        if (cell.decimal === highlightedDecimal) {
            highlightedCell = cell;
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
