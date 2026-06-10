"use client";

import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import {
    isGoogleMapsConfigured,
    loadGoogleMapsLibraries,
    type MapsLoaderStatus,
    readGoogleMapsApiKey,
    resolveInitialMapsStatus,
} from "../register/residence/google-maps-loader";
import { residenceCellBoundary, residenceCellCenter } from "../register/residence/h3-geo";
import { parseHomeCell } from "./home-cell";

// 読み取り専用ハイライトのポリゴンスタイル（選択 UI は持たない）。
const HIGHLIGHT_STYLE = {
    strokeColor: "#2f5d3a",
    strokeOpacity: 0.9,
    strokeWeight: 2,
    fillColor: "#7fae87",
    fillOpacity: 0.4,
} as const;

/**
 * 居住地セルを地図上に読み取り専用でハイライトする。
 *
 * 重い選択 UI（residence-cell-picker）は使わず、h3-geo の純粋関数と
 * google-maps-loader の薄いラッパだけで描画する。セルが無効、または地図 API
 * key が未設定の場合は地図を描かず、セル値のテキスト表示にフォールバックする。
 */
export function HomeCellMap({ cell }: { readonly cell: string }) {
    const t = useTranslations("mypage");
    const parsed = useMemo(() => parseHomeCell(cell), [cell]);
    const apiKey = readGoogleMapsApiKey();

    const mapElRef = useRef<HTMLDivElement | null>(null);
    const [status, setStatus] = useState<MapsLoaderStatus>(() =>
        parsed ? resolveInitialMapsStatus(apiKey) : "unconfigured",
    );

    useEffect(() => {
        if (!parsed || !isGoogleMapsConfigured(apiKey)) {
            return;
        }

        let cancelled = false;
        setStatus("loading");

        loadGoogleMapsLibraries(apiKey)
            .then(() => {
                if (cancelled) {
                    return;
                }
                const element = mapElRef.current;
                if (!element) {
                    return;
                }
                const center = residenceCellCenter(parsed.hex);
                const map = new google.maps.Map(element, {
                    center,
                    zoom: 13,
                    disableDefaultUI: true,
                    clickableIcons: false,
                    gestureHandling: "cooperative",
                });
                new google.maps.Polygon({
                    paths: residenceCellBoundary(parsed.hex),
                    map,
                    ...HIGHLIGHT_STYLE,
                });
                setStatus("ready");
            })
            .catch(() => {
                if (!cancelled) {
                    setStatus("error");
                }
            });

        return () => {
            cancelled = true;
        };
    }, [parsed, apiKey]);

    // セル無効 or key 未設定 → 地図は出さずテキストにフォールバック。
    if (!parsed || !isGoogleMapsConfigured(apiKey)) {
        return (
            <div className="mypage-map-fallback">
                <p className="mypage-map-title">{t("map.unavailableTitle")}</p>
                <p>{t("map.unavailableBody", { cell })}</p>
            </div>
        );
    }

    return (
        <div className="mypage-map">
            <div className="mypage-map-canvas" ref={mapElRef} />
            {status === "error" && (
                <p className="mypage-map-note">{t("map.unavailableBody", { cell })}</p>
            )}
        </div>
    );
}
