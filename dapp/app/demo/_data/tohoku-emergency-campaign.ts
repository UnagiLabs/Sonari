import type {
    EmergencyBannerCampaign,
    EmergencyBannerDetail,
} from "../../donate/emergency-banner-state";
import type { TohokuDemoEarthquake } from "./tohoku-2011";

/**
 * デモ用の固定キャンペーン ID。
 * 実在のオンチェーンキャンペーンではなく、表示専用の識別子。
 * デモモードの DonateView / HomeView は送金導線を持たないため、この ID で送金は発生しない。
 */
export const TOHOKU_DEMO_CAMPAIGN_ID = "demo-tohoku-2011";

/**
 * 緊急バナーに表示する概要ラベル（ローカライズ済み文字列）。
 * 値は固定データ側から決定的に作るため、ここではラベルだけ受け取る。
 */
export interface TohokuEmergencyLabels {
    readonly status: string;
    readonly magnitude: string;
    readonly mmi: string;
    readonly region: string;
    readonly date: string;
    readonly affectedCells: string;
    readonly h3Resolution: string;
    readonly epicenter: string;
}

/**
 * 東北デモデータとローカライズ済みラベルから、緊急バナー用のキャンペーンを組み立てる。
 * 表示値（M9.1 など）は data から決定的に生成し、ラベルだけ言語ごとに差し替える。
 * React / next-intl に依存しない純関数なので、vitest で直接検証できる。
 *
 * demo/donate と demo/home の両方がこの変換を使うため、特定ページ配下ではなく
 * 共有の _data 配下に置く。
 */
export function buildTohokuEmergencyCampaign(
    labels: TohokuEmergencyLabels,
    data: TohokuDemoEarthquake,
): EmergencyBannerCampaign {
    const details: readonly EmergencyBannerDetail[] = [
        { label: "M", value: String(data.magnitude) },
        { label: labels.mmi, value: `${data.mmi}` },
        { label: labels.region, value: data.region },
        { label: labels.date, value: data.occurredOn },
        {
            label: labels.affectedCells,
            value: data.affectedCellCount.toLocaleString("en-US"),
        },
        { label: labels.h3Resolution, value: `${data.h3Resolution}` },
        {
            label: labels.epicenter,
            value: `${data.epicenter.latitude}°N, ${data.epicenter.longitude}°E, ${data.epicenter.depthKm} km`,
        },
    ];

    return {
        id: TOHOKU_DEMO_CAMPAIGN_ID,
        label: data.title,
        status: labels.status,
        details,
    };
}
