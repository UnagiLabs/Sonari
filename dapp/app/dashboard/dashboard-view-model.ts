import { formatAmount, formatDate } from "../i18n/format";
import type { SonariLocale } from "../register/wizard/locale";
import type { DashboardPools } from "./dashboard-chain";
import type { DashboardDisasterEvent, StatusKey } from "./dashboard-events";

export type DashboardMetricKey =
    | "totalBalance"
    | "availableNow"
    | "reservedFloor"
    | "confirmedEvents";
export type DashboardPoolKey = "main" | "operations" | "earthquake";

export interface DashboardPoolSummary {
    readonly key: DashboardPoolKey;
    readonly balance: string;
    readonly received: string;
    readonly paidOut: string;
    readonly available: string;
    readonly percentAvailable: number;
    readonly status: StatusKey;
}

// 確定した情報源（最新 finalized DisasterEvent）を確定情報源パネルへ渡すための表示モデル。
// チェーン由来の値だけを保持し、ラベルや "cells" / "H3 r8" などの技術トークンは view 側で i18n 合成する。
export interface DashboardConfirmedSource {
    readonly present: boolean;
    readonly sourceEventId: string;
    readonly region: string;
    readonly hazard: string;
    readonly affectedCellsCount: string;
    readonly finalizedAt: string;
    readonly finalizedDate: string;
    readonly eventRevision: number;
    readonly donateHref: string;
}

export interface DashboardViewModel {
    readonly generatedAt: string;
    readonly metricKeys: readonly DashboardMetricKey[];
    readonly metricValues: Record<DashboardMetricKey, string>;
    readonly pools: readonly DashboardPoolSummary[];
    readonly latestEvent: DashboardConfirmedSource;
}

const METRIC_KEYS: readonly DashboardMetricKey[] = [
    "totalBalance",
    "availableNow",
    "reservedFloor",
    "confirmedEvents",
] as const;

interface CompactUsdUnit {
    readonly suffix: string;
    readonly scale: bigint;
}

const USDC_DECIMALS = 1_000_000n;
const WHOLE_USD_UNIT: CompactUsdUnit = { suffix: "", scale: 1n };
const COMPACT_USD_UNITS: readonly CompactUsdUnit[] = [
    WHOLE_USD_UNIT,
    { suffix: "K", scale: 1_000n },
    { suffix: "M", scale: 1_000_000n },
    { suffix: "B", scale: 1_000_000_000n },
    { suffix: "T", scale: 1_000_000_000_000n },
] as const;

export function deriveDashboardViewModel(input: {
    readonly locale: SonariLocale;
    readonly nowMs: number;
    readonly pools: DashboardPools;
    readonly latestEvent: DashboardDisasterEvent | null;
}): DashboardViewModel {
    // 表示対象は Main + Earthquake の2プールのみ。Operations pool は残高集計にも含めない。
    const mainAvailable = maxBigint(
        input.pools.main.balanceUsdc - input.pools.main.reserveFloorUsdc,
        0n,
    );
    const totalBalance = input.pools.main.balanceUsdc + input.pools.category.balanceUsdc;
    const availableNow = mainAvailable + input.pools.category.balanceUsdc;
    const confirmedEvents = input.latestEvent === null ? 0 : 1;

    return {
        generatedAt: formatTimestamp(input.nowMs, input.locale),
        metricKeys: METRIC_KEYS,
        metricValues: {
            totalBalance: formatUsdc(totalBalance, input.locale),
            availableNow: formatUsdc(availableNow, input.locale),
            reservedFloor: formatUsdc(input.pools.main.reserveFloorUsdc, input.locale),
            confirmedEvents: formatAmount(confirmedEvents, input.locale),
        },
        pools: deriveFeaturedPools(input.pools, input.locale),
        latestEvent: deriveConfirmedSource(input.latestEvent, input.locale),
    };
}

// HOME のトップページ用に、Main と Earthquake の2プールだけを整形して返す。
// Operations Pool は運営費のため含めない。ダッシュボードと同じ導出ロジックを再利用する。
export function deriveFeaturedPools(
    pools: DashboardPools,
    locale: SonariLocale,
): readonly DashboardPoolSummary[] {
    return [deriveMainPool(pools.main, locale), deriveCategoryPool(pools.category, locale)];
}

function deriveMainPool(
    pool: DashboardPools["main"],
    locale: SonariLocale,
): DashboardPoolSummary {
    const available = maxBigint(pool.balanceUsdc - pool.reserveFloorUsdc, 0n);
    return {
        key: "main",
        balance: formatUsdc(pool.balanceUsdc, locale),
        received: formatUsdc(pool.totalReceivedUsdc, locale),
        paidOut: formatUsdc(pool.totalFloorFundedUsdc, locale),
        available: formatUsdc(available, locale),
        percentAvailable: percentOf(available, pool.balanceUsdc),
        status: "active",
    };
}

function deriveCategoryPool(
    pool: DashboardPools["category"],
    locale: SonariLocale,
): DashboardPoolSummary {
    return {
        key: "earthquake",
        balance: formatUsdc(pool.balanceUsdc, locale),
        received: formatUsdc(pool.totalReceivedUsdc, locale),
        paidOut: formatUsdc(pool.totalFloorFundedUsdc, locale),
        available: formatUsdc(pool.balanceUsdc, locale),
        percentAvailable: percentOf(pool.balanceUsdc, pool.totalReceivedUsdc),
        status: "active",
    };
}

function deriveConfirmedSource(
    event: DashboardDisasterEvent | null,
    locale: SonariLocale,
): DashboardConfirmedSource {
    if (event === null) {
        return {
            present: false,
            sourceEventId: "",
            region: "",
            hazard: "",
            affectedCellsCount: formatAmount(0, locale),
            finalizedAt: "",
            finalizedDate: "",
            eventRevision: 0,
            donateHref: "",
        };
    }

    return {
        present: true,
        sourceEventId: event.sourceEventId,
        region: event.region,
        hazard: event.hazardLabel,
        affectedCellsCount: formatAmount(bigintToNumber(event.affectedCellCount), locale),
        finalizedAt: formatTimestamp(event.occurredAtMs, locale),
        finalizedDate: compactDate(event.occurredAtMs),
        eventRevision: event.eventRevision,
        donateHref: `/donate/${event.id}`,
    };
}

function formatTimestamp(ms: number, locale: SonariLocale): string {
    return (
        formatDate(ms, locale, {
            year: "numeric",
            month: "long",
            day: "numeric",
        }) ?? "Not available"
    );
}

// chain strip の「rev N · 確定日」用に locale 非依存の YYYY-MM-DD（UTC）を返す。
function compactDate(ms: number): string {
    if (ms <= 0) {
        return "";
    }
    return new Date(ms).toISOString().slice(0, 10);
}

function formatUsdc(value: bigint, locale: SonariLocale): string {
    const dollars = roundDiv(value, USDC_DECIMALS);
    const compact = compactWholeDollars(dollars);
    return `${formatAmount(bigintToNumber(compact.value), locale, {
        currency: "USD",
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
    })}${compact.suffix}`;
}

function percentOf(value: bigint, total: bigint): number {
    if (total <= 0n) {
        return 0;
    }
    return Math.max(0, Math.min(100, Math.round((bigintToNumber(value) / bigintToNumber(total)) * 100)));
}

function maxBigint(a: bigint, b: bigint): bigint {
    return a > b ? a : b;
}

function compactWholeDollars(value: bigint): { readonly value: bigint; readonly suffix: string } {
    let unitIndex = 0;
    let unit = WHOLE_USD_UNIT;
    for (let index = COMPACT_USD_UNITS.length - 1; index > 0; index -= 1) {
        const candidate = COMPACT_USD_UNITS[index];
        if (candidate !== undefined && value >= candidate.scale) {
            unitIndex = index;
            unit = candidate;
            break;
        }
    }

    let compactValue = roundDiv(value, unit.scale);
    while (compactValue >= 1_000n && unitIndex < COMPACT_USD_UNITS.length - 1) {
        const nextUnit = COMPACT_USD_UNITS[unitIndex + 1];
        if (nextUnit === undefined) {
            break;
        }
        unitIndex += 1;
        unit = nextUnit;
        compactValue = roundDiv(value, unit.scale);
    }

    return { value: compactValue, suffix: unit.suffix };
}

function roundDiv(value: bigint, divisor: bigint): bigint {
    return (value + divisor / 2n) / divisor;
}

function bigintToNumber(value: bigint): number {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    if (value > max) {
        return Number.MAX_SAFE_INTEGER;
    }
    return Number(value);
}
