import { parseH3Index } from "@sonari/proof-core";
import { cellToBoundary, cellToLatLng, latLngToCell, polygonToCells } from "h3-js";

// ---------------------------------------------------------------------------
// 定数・型
// ---------------------------------------------------------------------------

export const RESIDENCE_H3_RESOLUTION = 7;

export interface LatLng {
    readonly lat: number;
    readonly lng: number;
}

export interface ResidenceCell {
    readonly hex: string;
    readonly decimal: string;
}

export interface ViewportBounds {
    readonly north: number;
    readonly south: number;
    readonly east: number;
    readonly west: number;
}

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

/**
 * hex 文字列から ResidenceCell を組み立てる。
 * hex は h3-js native（小文字、接頭辞なし）を前提とする。
 */
function makeCellFromHex(hex: string): ResidenceCell {
    const decimal = h3HexToDecimal(hex);
    // parseH3Index で res7 および H3 cell の妥当性を保証する
    parseH3Index(decimal, RESIDENCE_H3_RESOLUTION);
    return { hex, decimal };
}

/**
 * string | ResidenceCell の入力を hex に解決する。
 * string の場合は16進文字列とみなす（接頭辞なし小文字）。
 */
function resolveHex(cell: string | ResidenceCell): string {
    return typeof cell === "string" ? cell : cell.hex;
}

// ---------------------------------------------------------------------------
// 16進 ↔ 10進変換
// ---------------------------------------------------------------------------

/**
 * h3-js native の小文字16進セルID → 10進 u64 文字列。
 * 例: "872c2a8bfffffff" → "614265551683510271"
 */
export function h3HexToDecimal(hex: string): string {
    return BigInt(`0x${hex}`).toString();
}

/**
 * 10進 u64 文字列 → h3-js native の小文字16進セルID。
 * 例: "614265551683510271" → "872c2a8bfffffff"
 */
export function h3DecimalToHex(decimal: string): string {
    return BigInt(decimal).toString(16);
}

// ---------------------------------------------------------------------------
// 座標 → セル変換
// ---------------------------------------------------------------------------

/**
 * 緯度経度から res7 の ResidenceCell を生成する。
 * 内部で parseH3Index を通して H3 cell 妥当性を保証する。
 */
export function latLngToResidenceCell(lat: number, lng: number): ResidenceCell {
    const hex = latLngToCell(lat, lng, RESIDENCE_H3_RESOLUTION);
    return makeCellFromHex(hex);
}

// ---------------------------------------------------------------------------
// セル → 座標変換
// ---------------------------------------------------------------------------

/**
 * セル（hex 文字列または ResidenceCell）の中心座標を返す。
 * 文字列入力は h3-js native の小文字16進文字列とみなす。
 */
export function residenceCellCenter(cell: string | ResidenceCell): LatLng {
    const hex = resolveHex(cell);
    const [lat, lng] = cellToLatLng(hex);
    return { lat, lng };
}

/**
 * セル（hex 文字列または ResidenceCell）の境界頂点を返す。
 * 文字列入力は h3-js native の小文字16進文字列とみなす。
 * cellToBoundary は [[lat, lng], ...] を返す（デフォルト非 GeoJSON 順）。
 */
export function residenceCellBoundary(cell: string | ResidenceCell): LatLng[] {
    const hex = resolveHex(cell);
    const coords = cellToBoundary(hex);
    return coords.map(([lat, lng]) => ({ lat, lng }));
}

// ---------------------------------------------------------------------------
// Viewport 内セル列挙
// ---------------------------------------------------------------------------

/**
 * ViewportBounds 矩形に含まれる res7 セルの16進ID配列を返す。
 * polygonToCells の polygon は [[lat, lng], ...] のループ（最初と最後が同一点）。
 */
export function residenceCellsInViewport(bounds: ViewportBounds): string[] {
    const { north, south, east, west } = bounds;
    // 矩形の頂点を時計回り（または反時計回り）でループとして与える
    const polygon: [number, number][] = [
        [north, west],
        [north, east],
        [south, east],
        [south, west],
        [north, west], // 閉じる
    ];
    return polygonToCells(polygon, RESIDENCE_H3_RESOLUTION);
}

// ---------------------------------------------------------------------------
// Advanced セル入力の正規化
// ---------------------------------------------------------------------------

/**
 * ユーザーが入力した生の16進セルID文字列を正規化して ResidenceCell を返す。
 *
 * 受理する形式:
 * - 素の hex（例: "872c2a8bfffffff"）
 * - "h3-" 接頭辞付き（例: "h3-872c2a8bfffffff"）
 * - "0x" 接頭辞付き（例: "0x872c2a8bfffffff"）
 * - 大文字混在（例: "872C2A8BFFFFFFF"）
 *
 * 処理手順:
 * 1. 接頭辞 "h3-" または "0x" を除去
 * 2. 小文字化
 * 3. 16進文字列として BigInt 変換 → 10進文字列化
 * 4. parseH3Index(decimal, 7) で res7 H3 cell の妥当性を検証
 *
 * 不正な入力、または res7 でない H3 index は Error を throw する。
 */
export function normalizeResidenceCellInput(raw: string): ResidenceCell {
    if (raw.length === 0) {
        throw new Error(`Invalid H3 cell input: empty string`);
    }

    // 接頭辞除去
    let stripped = raw;
    if (stripped.startsWith("h3-")) {
        stripped = stripped.slice(3);
    } else if (stripped.startsWith("0x") || stripped.startsWith("0X")) {
        stripped = stripped.slice(2);
    }

    // 小文字化
    const hex = stripped.toLowerCase();

    // 16進文字列として解釈
    if (!/^[0-9a-f]+$/.test(hex)) {
        throw new Error(
            `Invalid H3 cell input: contains non-hex characters: ${raw}`,
        );
    }

    let decimal: string;
    try {
        decimal = BigInt(`0x${hex}`).toString();
    } catch {
        throw new Error(`Invalid H3 cell input: cannot parse as hex: ${raw}`);
    }

    // parseH3Index で res7 かつ有効な H3 cell かを厳密に検証（失敗すれば throw）
    parseH3Index(decimal, RESIDENCE_H3_RESOLUTION);

    return { hex, decimal };
}
