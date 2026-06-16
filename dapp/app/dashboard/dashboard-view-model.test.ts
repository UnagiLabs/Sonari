import { describe, expect, it } from "vitest";
import type { DashboardPools } from "./dashboard-chain";
import type {
    DashboardClaimEvent,
    DashboardDisasterEvent,
    DashboardDonationEvent,
} from "./dashboard-events";
import { deriveDashboardViewModel, deriveFeaturedPools } from "./dashboard-view-model";

const pools: DashboardPools = {
    main: {
        key: "main",
        objectId: `0x${"11".repeat(32)}`,
        balanceUsdc: 12000000n,
        totalReceivedUsdc: 30000000n,
        totalFloorFundedUsdc: 7000000n,
        reserveFloorUsdc: 1000000n,
    },
    operations: {
        key: "operations",
        objectId: `0x${"22".repeat(32)}`,
        balanceUsdc: 4000000n,
        totalReceivedUsdc: 5000000n,
        totalSpentUsdc: 1000000n,
    },
    category: {
        key: "category",
        objectId: `0x${"33".repeat(32)}`,
        category: 1,
        balanceUsdc: 8000000n,
        totalReceivedUsdc: 9000000n,
        totalFloorFundedUsdc: 1000000n,
    },
};

const donation: DashboardDonationEvent = {
    kind: "donation",
    id: "donation:1",
    source: "general",
    label: "Donor 0x5555...5555",
    amountUsdc: 2500000n,
    actor: `0x${"55".repeat(32)}`,
    poolId: pools.main.objectId,
    occurredAtMs: 1700000000000,
    status: "confirmed",
};

const claim: DashboardClaimEvent = {
    kind: "claim",
    id: "claim:1",
    source: "floor",
    label: "recipient · 0x4444...4444",
    amountUsdc: 1000000n,
    campaignId: `0x${"44".repeat(32)}`,
    recipient: `0x${"66".repeat(32)}`,
    occurredAtMs: 1699999940000,
    status: "finalized",
};

const latestEvent: DashboardDisasterEvent = {
    id: `0x${"77".repeat(32)}`,
    sourceEventId: "usgs-1",
    eventRevision: 2,
    title: "M6.8 earthquake",
    region: "Offshore Iwate, Japan",
    hazardLabel: "earthquake",
    affectedCellCount: 1284n,
    occurredAtMs: 1699999900000,
    status: "finalized",
};

describe("deriveDashboardViewModel", () => {
    it("formats metrics, pools, activities, and event data from real inputs", () => {
        const view = deriveDashboardViewModel({
            locale: "en",
            nowMs: 1700000000000,
            pools,
            donations: [donation],
            claims: [claim],
            aidDeliveredUsdc: 1000000n,
            totalClaimsCount: 12,
            latestEvent,
        });

        expect(view.metricValues).toEqual({
            totalDonated: "$44.00",
            aidDelivered: "$1.00",
            activePools: "3",
            receipts: "12",
        });
        expect(view.metricDetails).toEqual({
            totalDonated: "Across all configured pools",
            aidDelivered: "Finalized floor and payout events",
            activePools: "3 pools read from chain",
            receipts: "12 finalized claim events",
        });
        expect(view.pools.map((pool) => pool.key)).toEqual(["main", "operations", "earthquake"]);
        expect(view.pools[0]?.available).toBe("$11.00");
        expect(view.pools[1]?.paidOut).toBe("$1.00");
        expect(view.donations[0]).toEqual({
            label: "Donor 0x5555...5555",
            meta: "general · now",
            amount: "$2.50",
            status: "confirmed",
        });
        expect(view.claims[0]).toEqual({
            label: "recipient · 0x4444...4444",
            meta: "floor · 1 minute ago",
            amount: "$1.00",
            status: "finalized",
        });
        expect(view.receipts[0]?.label).toBe("claim:1");
        expect(view.latestEvent).toEqual({
            id: latestEvent.id,
            source: "usgs-1",
            status: "finalized",
            region: "Offshore Iwate, Japan",
            intensity: "earthquake",
            affectedCells: "1,284 cells",
            claimWindow: "Created November 14, 2023",
        });
        expect(view.topDonors).toEqual([]);
        expect(view.topSponsors).toEqual([]);
    });

    it("uses empty display models instead of mock data", () => {
        const view = deriveDashboardViewModel({
            locale: "en",
            nowMs: 1700000000000,
            pools,
            donations: [],
            claims: [],
            aidDeliveredUsdc: 0n,
            totalClaimsCount: 0,
            latestEvent: null,
        });

        expect(view.donations).toEqual([]);
        expect(view.claims).toEqual([]);
        expect(view.receipts).toEqual([]);
        expect(view.latestEvent).toEqual({
            id: "",
            source: "Sui RPC",
            status: "pending",
            region: "No finalized event",
            intensity: "No hazard data",
            affectedCells: "0 cells",
            claimWindow: "Not available",
        });
    });
});

// 全残高ゼロのプール。残高が入っていない初期状態の検証に使う。
const emptyPools: DashboardPools = {
    main: {
        key: "main",
        objectId: `0x${"11".repeat(32)}`,
        balanceUsdc: 0n,
        totalReceivedUsdc: 0n,
        totalFloorFundedUsdc: 0n,
        reserveFloorUsdc: 0n,
    },
    operations: {
        key: "operations",
        objectId: `0x${"22".repeat(32)}`,
        balanceUsdc: 0n,
        totalReceivedUsdc: 0n,
        totalSpentUsdc: 0n,
    },
    category: {
        key: "category",
        objectId: `0x${"33".repeat(32)}`,
        category: 1,
        balanceUsdc: 0n,
        totalReceivedUsdc: 0n,
        totalFloorFundedUsdc: 0n,
    },
};

describe("deriveFeaturedPools", () => {
    it("returns only the main and earthquake pools with formatted values", () => {
        const featured = deriveFeaturedPools(pools, "en");

        expect(featured.map((pool) => pool.key)).toEqual(["main", "earthquake"]);
        expect(featured[0]?.available).toBe("$11.00");
        expect(featured[0]?.received).toBe("$30.00");
        expect(featured[0]?.paidOut).toBe("$7.00");
        expect(featured[1]?.available).toBe("$8.00");
        expect(featured[1]?.received).toBe("$9.00");
        expect(featured[1]?.paidOut).toBe("$1.00");
    });

    it("excludes the operations pool", () => {
        const featured = deriveFeaturedPools(pools, "en");

        expect(featured.some((pool) => pool.key === "operations")).toBe(false);
    });

    it("handles all-zero balances without throwing", () => {
        const featured = deriveFeaturedPools(emptyPools, "en");

        expect(featured.map((pool) => pool.key)).toEqual(["main", "earthquake"]);
        expect(featured[0]?.available).toBe("$0.00");
        expect(featured[0]?.percentAvailable).toBe(0);
        expect(featured[1]?.available).toBe("$0.00");
        expect(featured[1]?.percentAvailable).toBe(0);
    });
});
