// ---------------------------------------------------------------------------
// DisasterPoolView: 災害 Pool の表示用 ViewModel
//
// 入力: readonly ClaimCampaignState[]  + nowMs: number（隠れ state なし）
// 出力: readonly DisasterPoolView[]
//
// 純粋関数 / 副作用なし / any 禁止 / 入力配列を破壊しない
// ---------------------------------------------------------------------------

import type { ClaimCampaignState } from "../claim/claim-campaigns";

// ---------------------------------------------------------------------------
// 公開型
// ---------------------------------------------------------------------------

/** Pool の状態キー。優先順位: closed > paused > ended > active */
export type DisasterPoolStatus = "active" | "ended" | "paused" | "closed";

/** 一覧・トップカード・寄付ページ共通の表示用データ */
export interface DisasterPoolView {
    /** 災害イベント Object ID */
    readonly disasterEventId: string;
    /** Campaign Object ID */
    readonly campaignId: string;
    /** 災害タイトル */
    readonly title: string;
    /** 地域名 */
    readonly region: string;
    /** 被影響セル数（number に変換済み）*/
    readonly affectedCellCount: number;
    /** 寄付受付終了 epoch ms */
    readonly donationEndMs: number;
    /** 申請受付終了 epoch ms */
    readonly claimEndMs: number;
    /** Pool の状態 */
    readonly status: DisasterPoolStatus;
    /** 現在残高 (micro USDC)。データ欠損時 null */
    readonly balanceUsdc: number | null;
    /** 残高の整形済み表示文字列。null のとき "-" */
    readonly balanceLabel: string;
    /** 累計受入額 (micro USDC)。データ欠損時 null */
    readonly totalDonatedUsdc: number | null;
    /** 累計受入額の整形済み表示文字列。null のとき "-" */
    readonly totalDonatedLabel: string;
    /** 累計支払額 (micro USDC)。データ欠損時 null */
    readonly totalPaidUsdc: number | null;
    /** 累計支払額の整形済み表示文字列。null のとき "-" */
    readonly totalPaidLabel: string;
    /** 寄付ページへのリンク。常に `/donate/<disasterEventId>` */
    readonly href: string;
}

// ---------------------------------------------------------------------------
// 公開関数
// ---------------------------------------------------------------------------

/**
 * `ClaimCampaignState[]` を表示用 `DisasterPoolView[]` へ変換する pure 関数。
 *
 * - 並び順: `donationEndMs` 降順。同値は `campaignId` 昇順（安定・決定的）。
 * - 入力配列を破壊しない（元配列は変更されない）。
 * - 副作用なし・グローバル state なし。
 *
 * @param campaigns finalized 済み ClaimCampaignState の配列
 * @param nowMs     現在時刻 epoch ms（テスト用に引数で受け取る）
 */
export function buildDisasterPoolViews(
    campaigns: readonly ClaimCampaignState[],
    nowMs: number,
): readonly DisasterPoolView[] {
    return [...campaigns]
        .sort(compareByDonationEndDesc)
        .map((c) => toView(c, nowMs));
}

// ---------------------------------------------------------------------------
// 内部: ソート比較関数
// ---------------------------------------------------------------------------

function compareByDonationEndDesc(a: ClaimCampaignState, b: ClaimCampaignState): number {
    const endA = parseMsString(a.donationEndMs);
    const endB = parseMsString(b.donationEndMs);
    // donationEndMs 降順
    if (endB !== endA) {
        return endB - endA;
    }
    // 同値は campaignId 昇順（安定）
    if (a.campaignId < b.campaignId) return -1;
    if (a.campaignId > b.campaignId) return 1;
    return 0;
}

// ---------------------------------------------------------------------------
// 内部: ClaimCampaignState → DisasterPoolView
// ---------------------------------------------------------------------------

function toView(c: ClaimCampaignState, nowMs: number): DisasterPoolView {
    const donationEndMs = parseMsString(c.donationEndMs);
    const claimEndMs = parseMsString(c.claimEndMs);

    return {
        disasterEventId: c.disasterEventId,
        campaignId: c.campaignId,
        title: c.title,
        region: c.region,
        affectedCellCount: parseCellCount(c.affectedCellCount),
        donationEndMs,
        claimEndMs,
        status: deriveStatus(c, nowMs, donationEndMs),
        balanceUsdc: c.balanceUsdc,
        balanceLabel: formatMicroUsdc(c.balanceUsdc),
        totalDonatedUsdc: c.totalDonatedUsdc,
        totalDonatedLabel: formatMicroUsdc(c.totalDonatedUsdc),
        totalPaidUsdc: c.totalPaidUsdc,
        totalPaidLabel: formatMicroUsdc(c.totalPaidUsdc),
        href: `/donate/${c.disasterEventId}`,
    };
}

// ---------------------------------------------------------------------------
// 内部: status 判定（優先順位: closed > paused > ended > active）
// ---------------------------------------------------------------------------

function deriveStatus(
    c: ClaimCampaignState,
    nowMs: number,
    donationEndMs: number,
): DisasterPoolStatus {
    if (c.closed === true) return "closed";
    if (c.paused === true) return "paused";
    if (donationEndMs <= nowMs) return "ended";
    return "active";
}

// ---------------------------------------------------------------------------
// 内部: 金額整形（micro USDC → USD 表示、6桁 decimals）
// ---------------------------------------------------------------------------

const USD_FORMATTER = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

const MICRO_USDC_DECIMALS = 1_000_000;

/**
 * micro USDC (number) を "$X.XX" 形式にフォーマットする。
 * `null` のとき安全なプレースホルダ "-" を返す。
 */
function formatMicroUsdc(microUsdc: number | null): string {
    if (microUsdc === null) return "-";
    return USD_FORMATTER.format(microUsdc / MICRO_USDC_DECIMALS);
}

// ---------------------------------------------------------------------------
// 内部: パース helper
// ---------------------------------------------------------------------------

/**
 * 10進数 ms 文字列を number に変換する。
 * ClaimCampaignState の donationEndMs / claimEndMs は u64 文字列で来る。
 * 解析失敗時は 0 を返す（表示には影響するが、null より安全な sentinel）。
 */
function parseMsString(value: string): number {
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/**
 * affectedCellCount (u64 文字列) を number に変換する。
 * 解析失敗時は 0 を返す。
 */
function parseCellCount(value: string): number {
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}
