import type { OverlayCellKind } from "./residence-overlay";

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

/** 凡例スウォッチの見本種別。破線は CSS レベルで実現する。 */
export type CellLegendSwatch = "solid-bold" | "solid" | "dashed";

/** 凡例エントリ。labelKey は i18n キーのサフィックス（picker 配下）。 */
export interface CellLegendEntry {
    readonly kind: Exclude<OverlayCellKind, "pending">;
    readonly labelKey: string;
    readonly swatch: CellLegendSwatch;
}

// ---------------------------------------------------------------------------
// polygonStyleForKind
// ---------------------------------------------------------------------------

/**
 * OverlayCellKind に対応した Google Maps PolygonOptions を返す。
 *
 * strokeWeight により状態を枠線の太さで区別する:
 *   selected 3.5 / selectable 1.5 / disabled 1 / pending 1
 *
 * disabled（海セル）は clickable:true を維持する（理由メッセージ表示のため）。
 * 入力の kind を変更せず、毎回新しいオブジェクトを返す（immutable）。
 */
export function polygonStyleForKind(kind: OverlayCellKind): google.maps.PolygonOptions {
    switch (kind) {
        case "selected":
            return {
                strokeColor: "#2f5d3a",
                strokeOpacity: 1,
                strokeWeight: 3.5,
                fillColor: "#5b9268",
                fillOpacity: 0.45,
                clickable: true,
                zIndex: 10,
            };
        case "selectable":
            return {
                strokeColor: "#4f7d5a",
                strokeOpacity: 0.85,
                strokeWeight: 1.5,
                fillColor: "#7fae87",
                fillOpacity: 0.18,
                clickable: true,
                zIndex: 1,
            };
        case "disabled":
            return {
                strokeColor: "#9aa0a6",
                strokeOpacity: 0.5,
                strokeWeight: 1,
                fillColor: "#9aa0a6",
                fillOpacity: 0.4,
                // 海セルもクリックは受け付け、理由メッセージを出すために clickable にする。
                clickable: true,
                zIndex: 1,
            };
        case "pending":
            return {
                strokeColor: "#c7ccd1",
                strokeOpacity: 0.4,
                strokeWeight: 1,
                fillColor: "#c7ccd1",
                fillOpacity: 0.08,
                clickable: true,
                zIndex: 1,
            };
    }
}

// ---------------------------------------------------------------------------
// buildCellLegendEntries
// ---------------------------------------------------------------------------

/**
 * 地図凡例に表示するエントリを返す。
 *
 * pending は一時状態のため凡例に含めない。
 * 順序: selected → selectable → disabled
 */
export function buildCellLegendEntries(): readonly CellLegendEntry[] {
    return [
        {
            kind: "selected",
            labelKey: "legend.selected",
            swatch: "solid-bold",
        },
        {
            kind: "selectable",
            labelKey: "legend.selectable",
            swatch: "solid",
        },
        {
            kind: "disabled",
            labelKey: "legend.disabled",
            swatch: "dashed",
        },
    ] as const;
}
