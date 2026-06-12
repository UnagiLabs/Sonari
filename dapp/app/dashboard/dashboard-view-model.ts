import { formatAmount, formatDate, formatRelativeTime } from "../i18n/format";
import type { SonariLocale } from "../register/wizard/locale";
import type { DashboardPools } from "./dashboard-chain";
import type {
    DashboardClaimEvent,
    DashboardDisasterEvent,
    DashboardDonationEvent,
    StatusKey,
} from "./dashboard-events";

export type DashboardMetricKey = "totalDonated" | "aidDelivered" | "activePools" | "receipts";
export type DashboardPoolKey = "main" | "operations" | "category";

export interface DashboardPoolSummary {
    readonly key: DashboardPoolKey;
    readonly balance: string;
    readonly received: string;
    readonly paidOut: string;
    readonly reserved: string;
    readonly available: string;
    readonly percentAvailable: number;
    readonly status: StatusKey;
}

export interface DashboardActivityItem {
    readonly label: string;
    readonly meta: string;
    readonly amount: string;
    readonly status: StatusKey;
}

export interface DashboardSupporter {
    readonly name: string;
    readonly meta: string;
    readonly amount: string;
    readonly rank: number;
}

export interface DashboardLatestEventView {
    readonly id: string;
    readonly source: string;
    readonly status: StatusKey;
    readonly region: string;
    readonly intensity: string;
    readonly affectedCells: string;
    readonly claimWindow: string;
}

export interface DashboardViewModel {
    readonly generatedAt: string;
    readonly metricKeys: readonly DashboardMetricKey[];
    readonly metricValues: Record<DashboardMetricKey, string>;
    readonly metricDetails: Record<DashboardMetricKey, string>;
    readonly pools: readonly DashboardPoolSummary[];
    readonly latestEvent: DashboardLatestEventView;
    readonly donations: readonly DashboardActivityItem[];
    readonly claims: readonly DashboardActivityItem[];
    readonly receipts: readonly DashboardActivityItem[];
    readonly topDonors: readonly DashboardSupporter[];
    readonly topSponsors: readonly DashboardSupporter[];
}

const METRIC_KEYS: readonly DashboardMetricKey[] = [
    "totalDonated",
    "aidDelivered",
    "activePools",
    "receipts",
] as const;

const USDC_DECIMALS = 1_000_000n;

export function deriveDashboardViewModel(input: {
    readonly locale: SonariLocale;
    readonly nowMs: number;
    readonly pools: DashboardPools;
    readonly donations: readonly DashboardDonationEvent[];
    readonly claims: readonly DashboardClaimEvent[];
    readonly aidDeliveredUsdc: bigint;
    readonly totalClaimsCount: number;
    readonly latestEvent: DashboardDisasterEvent | null;
}): DashboardViewModel {
    const totalDonated =
        input.pools.main.totalReceivedUsdc +
        input.pools.operations.totalReceivedUsdc +
        input.pools.category.totalReceivedUsdc;
    const activePools = [
        input.pools.main,
        input.pools.operations,
        input.pools.category,
    ].filter((pool) => pool.balanceUsdc > 0n).length;

    return {
        generatedAt: formatTimestamp(input.nowMs, input.locale),
        metricKeys: METRIC_KEYS,
        metricValues: {
            totalDonated: formatUsdc(totalDonated, input.locale),
            aidDelivered: formatUsdc(input.aidDeliveredUsdc, input.locale),
            activePools: formatAmount(activePools, input.locale),
            receipts: formatAmount(input.totalClaimsCount, input.locale),
        },
        metricDetails: {
            totalDonated: "Across all configured pools",
            aidDelivered: "Finalized floor and payout events",
            activePools: `${activePools} pools read from chain`,
            receipts: `${input.totalClaimsCount} finalized claim event${input.totalClaimsCount === 1 ? "" : "s"}`,
        },
        pools: [
            deriveMainPool(input.pools.main, input.locale),
            deriveOperationsPool(input.pools.operations, input.locale),
            deriveCategoryPool(input.pools.category, input.locale),
        ],
        latestEvent: deriveLatestEvent(input.latestEvent, input.locale),
        donations: input.donations.map((item) => deriveActivity(item, input.locale, input.nowMs)),
        claims: input.claims.map((item) => deriveActivity(item, input.locale, input.nowMs)),
        receipts: input.claims.map((item) => deriveReceipt(item, input.locale, input.nowMs)),
        topDonors: [],
        topSponsors: [],
    };
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
        reserved: formatUsdc(pool.reserveFloorUsdc, locale),
        available: formatUsdc(available, locale),
        percentAvailable: percentOf(available, pool.balanceUsdc),
        status: "active",
    };
}

function deriveOperationsPool(
    pool: DashboardPools["operations"],
    locale: SonariLocale,
): DashboardPoolSummary {
    return {
        key: "operations",
        balance: formatUsdc(pool.balanceUsdc, locale),
        received: formatUsdc(pool.totalReceivedUsdc, locale),
        paidOut: formatUsdc(pool.totalSpentUsdc, locale),
        reserved: formatUsdc(0n, locale),
        available: formatUsdc(pool.balanceUsdc, locale),
        percentAvailable: percentOf(pool.balanceUsdc, pool.totalReceivedUsdc),
        status: "active",
    };
}

function deriveCategoryPool(
    pool: DashboardPools["category"],
    locale: SonariLocale,
): DashboardPoolSummary {
    return {
        key: "category",
        balance: formatUsdc(pool.balanceUsdc, locale),
        received: formatUsdc(pool.totalReceivedUsdc, locale),
        paidOut: formatUsdc(pool.totalFloorFundedUsdc, locale),
        reserved: formatUsdc(0n, locale),
        available: formatUsdc(pool.balanceUsdc, locale),
        percentAvailable: percentOf(pool.balanceUsdc, pool.totalReceivedUsdc),
        status: "active",
    };
}

function deriveActivity(
    item: DashboardDonationEvent | DashboardClaimEvent,
    locale: SonariLocale,
    nowMs: number,
): DashboardActivityItem {
    return {
        label: item.label,
        meta: `${item.source} · ${relativeTime(item.occurredAtMs, nowMs, locale)}`,
        amount: formatUsdc(item.amountUsdc, locale),
        status: item.status,
    };
}

function deriveReceipt(
    item: DashboardClaimEvent,
    locale: SonariLocale,
    nowMs: number,
): DashboardActivityItem {
    return {
        label: item.id,
        meta: `${shortId(item.campaignId)} · ${relativeTime(item.occurredAtMs, nowMs, locale)}`,
        amount: formatUsdc(item.amountUsdc, locale),
        status: item.status,
    };
}

function deriveLatestEvent(
    event: DashboardDisasterEvent | null,
    locale: SonariLocale,
): DashboardLatestEventView {
    if (event === null) {
        return {
            id: "",
            source: "Sui RPC",
            status: "pending",
            region: "No finalized event",
            intensity: "No hazard data",
            affectedCells: "0 cells",
            claimWindow: "Not available",
        };
    }

    return {
        id: event.id,
        source: event.sourceEventId,
        status: event.status,
        region: event.region,
        intensity: event.hazardLabel,
        affectedCells: `${formatAmount(bigintToNumber(event.affectedCellCount), locale)} cells`,
        claimWindow: `Created ${formatTimestamp(event.occurredAtMs, locale)}`,
    };
}

function relativeTime(occurredAtMs: number, nowMs: number, locale: SonariLocale): string {
    const diffMs = occurredAtMs - nowMs;
    const absMs = Math.abs(diffMs);
    const minuteMs = 60_000;
    const hourMs = 60 * minuteMs;
    const dayMs = 24 * hourMs;

    if (absMs < minuteMs) {
        return formatRelativeTime(0, "second", locale);
    }
    if (absMs < hourMs) {
        return formatRelativeTime(Math.round(diffMs / minuteMs), "minute", locale);
    }
    if (absMs < dayMs) {
        return formatRelativeTime(Math.round(diffMs / hourMs), "hour", locale);
    }
    return formatRelativeTime(Math.round(diffMs / dayMs), "day", locale);
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

function formatUsdc(value: bigint, locale: SonariLocale): string {
    return formatAmount(bigintToNumber(value) / Number(USDC_DECIMALS), locale, {
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
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

function bigintToNumber(value: bigint): number {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    if (value > max) {
        return Number.MAX_SAFE_INTEGER;
    }
    return Number(value);
}

function shortId(value: string): string {
    return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}
