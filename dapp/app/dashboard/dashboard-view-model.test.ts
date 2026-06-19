import { describe, expect, it } from "vitest";
import type { DashboardPools } from "./dashboard-chain";
import type { DashboardDisasterEvent } from "./dashboard-events";
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
    it("aggregates only the displayed pools and the confirmed source event", () => {
        const view = deriveDashboardViewModel({
            locale: "en",
            nowMs: 1700000000000,
            pools,
            latestEvent,
        });

        // メトリクスは表示対象2プール（Main + Earthquake）のみで集計し Operations は含めない。
        expect(view.metricKeys).toEqual([
            "totalBalance",
            "availableNow",
            "reservedFloor",
            "confirmedEvents",
        ]);
        expect(view.metricValues).toEqual({
            totalBalance: "$20", // main 12 + earthquake 8
            availableNow: "$19", // (12 - 1) + 8
            reservedFloor: "$1", // main reserve floor
            confirmedEvents: "1", // finalized event present
        });

        // プールは Main と Earthquake の2件のみ。Operations は出さない。
        expect(view.pools.map((pool) => pool.key)).toEqual(["main", "earthquake"]);
        expect(view.pools[0]?.available).toBe("$11");
        expect(view.pools[1]?.available).toBe("$8");

        expect(view.latestEvent).toEqual({
            present: true,
            sourceEventId: "usgs-1",
            region: "Offshore Iwate, Japan",
            hazard: "earthquake",
            affectedCellsCount: "1,284",
            finalizedAt: "November 14, 2023",
            finalizedDate: "2023-11-14",
            eventRevision: 2,
            donateHref: `/donate/${latestEvent.id}`,
        });
    });

    it("returns an empty confirmed source and zero event count when no event is finalized", () => {
        const view = deriveDashboardViewModel({
            locale: "en",
            nowMs: 1700000000000,
            pools,
            latestEvent: null,
        });

        expect(view.metricValues.confirmedEvents).toBe("0");
        expect(view.latestEvent).toEqual({
            present: false,
            sourceEventId: "",
            region: "",
            hazard: "",
            affectedCellsCount: "0",
            finalizedAt: "",
            finalizedDate: "",
            eventRevision: 0,
            donateHref: "",
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
        expect(featured[0]?.available).toBe("$11");
        expect(featured[0]?.received).toBe("$30");
        expect(featured[0]?.paidOut).toBe("$7");
        expect(featured[1]?.available).toBe("$8");
        expect(featured[1]?.received).toBe("$9");
        expect(featured[1]?.paidOut).toBe("$1");
    });

    it("rounds fractional dollars and compacts large values", () => {
        const featured = deriveFeaturedPools(
            {
                ...pools,
                main: {
                    ...pools.main,
                    balanceUsdc: 100_499_499_999_999n,
                    totalReceivedUsdc: 1_500_000_000n,
                    totalFloorFundedUsdc: 499_500_000n,
                    reserveFloorUsdc: 500_000n,
                },
                category: {
                    ...pools.category,
                    balanceUsdc: 99_999_999_500_000n,
                    totalReceivedUsdc: 999_500_000_000n,
                    totalFloorFundedUsdc: 12_345_678n,
                },
            },
            "en",
        );

        expect(featured[0]?.balance).toBe("$100M");
        expect(featured[0]?.received).toBe("$2K");
        expect(featured[0]?.paidOut).toBe("$500");
        expect(featured[1]?.balance).toBe("$100M");
        expect(featured[1]?.received).toBe("$1M");
        expect(featured[1]?.paidOut).toBe("$12");
    });

    it("excludes the operations pool", () => {
        const featured = deriveFeaturedPools(pools, "en");

        expect(featured.some((pool) => pool.key === "operations")).toBe(false);
    });

    it("handles all-zero balances without throwing", () => {
        const featured = deriveFeaturedPools(emptyPools, "en");

        expect(featured.map((pool) => pool.key)).toEqual(["main", "earthquake"]);
        expect(featured[0]?.available).toBe("$0");
        expect(featured[0]?.percentAvailable).toBe(0);
        expect(featured[1]?.available).toBe("$0");
        expect(featured[1]?.percentAvailable).toBe(0);
    });
});
