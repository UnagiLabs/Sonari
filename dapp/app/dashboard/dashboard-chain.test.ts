import { describe, expect, it, vi } from "vitest";
import {
    type DashboardPoolReadClient,
    parseCategoryPoolObject,
    parseCategoryPoolCreatedEvent,
    parseDashboardPoolIds,
    parseMainPoolObject,
    parseOperationsPoolObject,
    readEarthquakeCategoryPoolId,
    readDashboardPools,
} from "./dashboard-chain";

const MAIN_POOL_ID = `0x${"11".repeat(32)}`;
const OPERATIONS_POOL_ID = `0x${"22".repeat(32)}`;
const CATEGORY_POOL_ID = `0x${"33".repeat(32)}`;

const poolIds = {
    NEXT_PUBLIC_SONARI_MAIN_POOL_ID: MAIN_POOL_ID,
    NEXT_PUBLIC_SONARI_OPERATIONS_POOL_ID: OPERATIONS_POOL_ID,
};

function balance(value: string): Record<string, unknown> {
    return { value };
}

function mainPoolJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        balance: balance("12000000"),
        total_received_usdc: "30000000",
        total_floor_funded_usdc: "7000000",
        reserve_floor_usdc: "1000000",
        ...overrides,
    };
}

function operationsPoolJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        balance: balance("4000000"),
        total_received_usdc: "5000000",
        total_spent_usdc: "1000000",
        ...overrides,
    };
}

function categoryPoolJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        category: 1,
        balance: balance("8000000"),
        total_received_usdc: "9000000",
        total_floor_funded_usdc: "1000000",
        ...overrides,
    };
}

describe("parseDashboardPoolIds", () => {
    it("returns configured pool ids", () => {
        expect(parseDashboardPoolIds(poolIds)).toEqual({
            kind: "ok",
            ids: {
                mainPoolId: MAIN_POOL_ID,
                operationsPoolId: OPERATIONS_POOL_ID,
            },
        });
    });

    it("fails closed when an id is missing or malformed", () => {
        expect(
            parseDashboardPoolIds({
                ...poolIds,
                NEXT_PUBLIC_SONARI_MAIN_POOL_ID: "not-an-id",
            }),
        ).toEqual({
            kind: "error",
            message: "NEXT_PUBLIC_SONARI_MAIN_POOL_ID must be a 32-byte Sui object id.",
        });
    });
});

describe("readEarthquakeCategoryPoolId", () => {
    it("selects the category=1 pool from CategoryPoolCreated events", async () => {
        const queryEvents = vi.fn(async () => ({
            data: [
                { parsedJson: { pool_id: `0x${"44".repeat(32)}`, category: 2 } },
                { parsedJson: { pool_id: CATEGORY_POOL_ID, category: 1 } },
            ],
            hasNextPage: false,
        }));

        await expect(
            readEarthquakeCategoryPoolId({ queryEvents }, { packageId: `0x${"ab".repeat(32)}` }),
        ).resolves.toEqual({ kind: "ok", categoryPoolId: CATEGORY_POOL_ID });
    });

    it("fails closed when the earthquake category pool is not found", async () => {
        const queryEvents = vi.fn(async () => ({
            data: [{ parsedJson: { pool_id: `0x${"44".repeat(32)}`, category: 2 } }],
            hasNextPage: false,
        }));

        await expect(
            readEarthquakeCategoryPoolId({ queryEvents }, { packageId: `0x${"ab".repeat(32)}` }),
        ).resolves.toEqual({
            kind: "error",
            message: "Earthquake category pool was not found on chain.",
        });
    });
});

describe("parseCategoryPoolCreatedEvent", () => {
    it("parses category pool created events", () => {
        expect(parseCategoryPoolCreatedEvent({ pool_id: CATEGORY_POOL_ID, category: 1 })).toEqual({
            poolId: CATEGORY_POOL_ID,
            category: 1,
        });
    });

    it("returns null for malformed category pool created events", () => {
        expect(parseCategoryPoolCreatedEvent({ pool_id: "bad", category: 1 })).toBeNull();
        expect(parseCategoryPoolCreatedEvent({ pool_id: CATEGORY_POOL_ID, category: 999 })).toBeNull();
    });
});

describe("pool object parsers", () => {
    it("parses MainPool fields and validates object type", () => {
        expect(
            parseMainPoolObject({
                objectId: MAIN_POOL_ID,
                type: "0xabc::pools::MainPool",
                json: mainPoolJson(),
            }),
        ).toEqual({
            key: "main",
            objectId: MAIN_POOL_ID,
            balanceUsdc: 12000000n,
            totalReceivedUsdc: 30000000n,
            totalFloorFundedUsdc: 7000000n,
            reserveFloorUsdc: 1000000n,
        });
    });

    it("parses OperationsPool fields and validates object type", () => {
        expect(
            parseOperationsPoolObject({
                objectId: OPERATIONS_POOL_ID,
                type: "0xabc::pools::OperationsPool",
                json: operationsPoolJson(),
            }),
        ).toEqual({
            key: "operations",
            objectId: OPERATIONS_POOL_ID,
            balanceUsdc: 4000000n,
            totalReceivedUsdc: 5000000n,
            totalSpentUsdc: 1000000n,
        });
    });

    it("parses CategoryPool fields and validates object type", () => {
        expect(
            parseCategoryPoolObject({
                objectId: CATEGORY_POOL_ID,
                type: "0xabc::category_pool::CategoryPool",
                json: categoryPoolJson(),
            }),
        ).toEqual({
            key: "category",
            objectId: CATEGORY_POOL_ID,
            category: 1,
            balanceUsdc: 8000000n,
            totalReceivedUsdc: 9000000n,
            totalFloorFundedUsdc: 1000000n,
        });
    });

    it("returns null for malformed u64, missing fields, and wrong object type", () => {
        expect(
            parseMainPoolObject({
                objectId: MAIN_POOL_ID,
                type: "0xabc::pools::OperationsPool",
                json: mainPoolJson(),
            }),
        ).toBeNull();
        expect(
            parseMainPoolObject({
                objectId: MAIN_POOL_ID,
                type: "0xabc::pools::MainPool",
                json: mainPoolJson({ total_received_usdc: "-1" }),
            }),
        ).toBeNull();
        expect(
            parseMainPoolObject({
                objectId: MAIN_POOL_ID,
                type: "0xabc::pools::MainPool",
                json: mainPoolJson({ balance: { bad: "12000000" } }),
            }),
        ).toBeNull();
    });
});

describe("readDashboardPools", () => {
    it("reads all dashboard pools with a stub client", async () => {
        const client: DashboardPoolReadClient = {
            getObjects: vi.fn(async () => ({
                objects: [
                    {
                        objectId: MAIN_POOL_ID,
                        type: "0xabc::pools::MainPool",
                        json: mainPoolJson(),
                    },
                    {
                        objectId: OPERATIONS_POOL_ID,
                        type: "0xabc::pools::OperationsPool",
                        json: operationsPoolJson(),
                    },
                    {
                        objectId: CATEGORY_POOL_ID,
                        type: "0xabc::category_pool::CategoryPool",
                        json: categoryPoolJson(),
                    },
                ],
            })),
        };

        const result = await readDashboardPools(client, {
            mainPoolId: MAIN_POOL_ID,
            operationsPoolId: OPERATIONS_POOL_ID,
            categoryPoolId: CATEGORY_POOL_ID,
        });

        expect(result).toEqual({
            kind: "ok",
            pools: {
                main: {
                    key: "main",
                    objectId: MAIN_POOL_ID,
                    balanceUsdc: 12000000n,
                    totalReceivedUsdc: 30000000n,
                    totalFloorFundedUsdc: 7000000n,
                    reserveFloorUsdc: 1000000n,
                },
                operations: {
                    key: "operations",
                    objectId: OPERATIONS_POOL_ID,
                    balanceUsdc: 4000000n,
                    totalReceivedUsdc: 5000000n,
                    totalSpentUsdc: 1000000n,
                },
                category: {
                    key: "category",
                    objectId: CATEGORY_POOL_ID,
                    category: 1,
                    balanceUsdc: 8000000n,
                    totalReceivedUsdc: 9000000n,
                    totalFloorFundedUsdc: 1000000n,
                },
            },
        });

        expect(client.getObjects).toHaveBeenCalledWith({
            objectIds: [MAIN_POOL_ID, OPERATIONS_POOL_ID, CATEGORY_POOL_ID],
            include: { json: true },
        });
    });

    it("returns an error instead of fallback data when a pool is malformed", async () => {
        const client: DashboardPoolReadClient = {
            getObjects: vi.fn(async () => ({
                objects: [
                    {
                        objectId: MAIN_POOL_ID,
                        type: "0xabc::pools::MainPool",
                        json: mainPoolJson({ reserve_floor_usdc: undefined }),
                    },
                    {
                        objectId: OPERATIONS_POOL_ID,
                        type: "0xabc::pools::OperationsPool",
                        json: operationsPoolJson(),
                    },
                    {
                        objectId: CATEGORY_POOL_ID,
                        type: "0xabc::category_pool::CategoryPool",
                        json: categoryPoolJson(),
                    },
                ],
            })),
        };

        await expect(
            readDashboardPools(client, {
                mainPoolId: MAIN_POOL_ID,
                operationsPoolId: OPERATIONS_POOL_ID,
                categoryPoolId: CATEGORY_POOL_ID,
            }),
        ).resolves.toEqual({
            kind: "error",
            message: "Dashboard pool response is invalid.",
        });
    });
});
