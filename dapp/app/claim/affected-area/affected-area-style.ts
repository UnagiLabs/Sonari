import { type CellBand, bandAmount, bandColor } from "../catalog/cell-band-rules";
import type { AffectedCell } from "./affected-cells";

// ---------------------------------------------------------------------------
// AffectedCellPolygonStyle
// ---------------------------------------------------------------------------

/**
 * 地図ポリゴンの見た目（google.maps.PolygonOptions 互換のサブセット）。
 * 地図 SDK には依存しない純粋なデータ構造。
 */
export interface AffectedCellPolygonStyle {
    readonly fillColor: string;
    readonly fillOpacity: number;
    readonly strokeColor: string;
    readonly strokeOpacity: number;
    readonly strokeWeight: number;
    readonly zIndex: number;
}

// 通常セルのスタイル定数
const NORMAL_STROKE_COLOR = "#1f2937"; // 視認できる濃いグレー
const NORMAL_STROKE_OPACITY = 0.6;
const NORMAL_STROKE_WEIGHT = 1;
const NORMAL_FILL_OPACITY = 0.35;
const NORMAL_Z_INDEX = 1;

// 強調セル（自宅）のスタイル定数（strokeWeight・zIndex は通常より大きい）
const HIGHLIGHT_STROKE_COLOR = "#1f2937"; // 同色で太さで強調
const HIGHLIGHT_STROKE_OPACITY = 0.9;
const HIGHLIGHT_STROKE_WEIGHT = 3; // 通常 1 より大きい
const HIGHLIGHT_FILL_OPACITY = 0.45;
const HIGHLIGHT_Z_INDEX = 10; // 通常 1 より大きい

/**
 * バンドと強調有無からポリゴンスタイルを返す純粋関数。
 *
 * - fillColor は bandColor(band) を使う（色の定義は #382 のルール）。
 * - 通常セル: 細い枠線（strokeWeight=1）・低 zIndex（=1）。
 * - 強調セル（自宅）: 太い枠線（strokeWeight=3）・高 zIndex（=10）。
 *   バンドの塗り色は残したまま枠線で強調する。
 *
 * 地図 SDK には依存しない（純粋関数）。
 */
export function polygonStyleForBand(
    band: CellBand,
    highlighted: boolean,
): AffectedCellPolygonStyle {
    const fillColor = bandColor(band);

    if (highlighted) {
        return {
            fillColor,
            fillOpacity: HIGHLIGHT_FILL_OPACITY,
            strokeColor: HIGHLIGHT_STROKE_COLOR,
            strokeOpacity: HIGHLIGHT_STROKE_OPACITY,
            strokeWeight: HIGHLIGHT_STROKE_WEIGHT,
            zIndex: HIGHLIGHT_Z_INDEX,
        };
    }

    return {
        fillColor,
        fillOpacity: NORMAL_FILL_OPACITY,
        strokeColor: NORMAL_STROKE_COLOR,
        strokeOpacity: NORMAL_STROKE_OPACITY,
        strokeWeight: NORMAL_STROKE_WEIGHT,
        zIndex: NORMAL_Z_INDEX,
    };
}

// ---------------------------------------------------------------------------
// shortenCellId
// ---------------------------------------------------------------------------

// 短縮表示のパラメータ
const SHORT_HEAD = 6;
const SHORT_TAIL = 4;
// length > SHORT_HEAD + SHORT_TAIL + 1（=11）のときだけ省略する
const SHORT_THRESHOLD = SHORT_HEAD + SHORT_TAIL + 1;

/**
 * 10進セルID（長い数字列）を短縮表示する。先頭と末尾を残し中央を省略記号にする。
 *
 * - `decimal.length > 11`（SHORT_HEAD=6 + SHORT_TAIL=4 + 1）のとき:
 *   `${decimal.slice(0, 6)}…${decimal.slice(-4)}` を返す。
 * - 11桁以下はそのまま返す（省略しない）。
 * - 省略記号は U+2026（`…`）1文字。
 *
 * 例: `"608795190286614527"`（18桁）→ `"608795…4527"`
 */
export function shortenCellId(decimal: string): string {
    if (decimal.length <= SHORT_THRESHOLD) {
        return decimal;
    }
    return `${decimal.slice(0, SHORT_HEAD)}…${decimal.slice(-SHORT_TAIL)}`;
}

// ---------------------------------------------------------------------------
// AffectedCellDetail / buildCellDetail
// ---------------------------------------------------------------------------

/** タップ時に小パネルへ出す表示用データ（文言の翻訳は呼び出し側が行う）。 */
export interface AffectedCellDetail {
    /** バンド値（実データの値）。 */
    readonly band: CellBand;
    /** 表示用金額（USDC, デモ値）。bandAmount(band)。 */
    readonly amountUsdc: number;
    /** 短縮セルID。 */
    readonly shortCellId: string;
    /** 元の10進セルID（コピー等に使える完全値）。 */
    readonly decimal: string;
}

/**
 * 被災セルからタップ詳細データを組み立てる純粋関数。値の組み立てのみ（翻訳しない）。
 *
 * - `band`        = cell.band
 * - `amountUsdc`  = bandAmount(cell.band)（金額定義は #382 のルール）
 * - `shortCellId` = shortenCellId(cell.decimal)
 * - `decimal`     = cell.decimal
 */
export function buildCellDetail(cell: AffectedCell): AffectedCellDetail {
    return {
        band: cell.band,
        amountUsdc: bandAmount(cell.band),
        shortCellId: shortenCellId(cell.decimal),
        decimal: cell.decimal,
    };
}
