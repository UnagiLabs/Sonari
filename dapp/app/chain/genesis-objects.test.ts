import { describe, expect, it, vi } from "vitest";
import {
    GENESIS_OBJECT_KIND,
    parseGenesisObjectCreatedEvent,
    readGenesisObjectIds,
    resolveMembershipDappGenesisObjects,
    selectGenesisObjectId,
} from "./genesis-objects";

const PACKAGE_ID = `0x${"ab".repeat(32)}`;
const PAUSE_STATE_ID = `0x${"02".repeat(32)}`;
const MAIN_POOL_ID = `0x${"03".repeat(32)}`;
const OPERATIONS_POOL_ID = `0x${"04".repeat(32)}`;
const DONOR_REGISTRY_ID = `0x${"05".repeat(32)}`;
const MEMBERSHIP_REGISTRY_ID = `0x${"06".repeat(32)}`;
const IDENTITY_REGISTRY_ID = `0x${"09".repeat(32)}`;
const CATEGORY_REGISTRY_ID = `0x${"0a".repeat(32)}`;
const EARTHQUAKE_POOL_ID = `0x${"0b".repeat(32)}`;
const ALLOWED_RESIDENCE_CELL_REGISTRY_ID = `0x${"0d".repeat(32)}`;
const CELL_COUNT_INDEX_ID = `0x${"0e".repeat(32)}`;

function genesisEvent(
    objectId: string,
    objectKind: number,
    createdAtMs = "1000",
): { readonly parsedJson: Record<string, unknown> } {
    return {
        parsedJson: {
            object_id: objectId,
            object_kind: objectKind,
            shared: true,
            created_at_ms: createdAtMs,
            actor: `0x${"99".repeat(32)}`,
        },
    };
}

describe("parseGenesisObjectCreatedEvent", () => {
    it("keeps object kind constants aligned with admin.move", () => {
        expect(GENESIS_OBJECT_KIND.allowedResidenceCellRegistry).toBe(13);
        expect(GENESIS_OBJECT_KIND.cellCountIndex).toBe(14);
    });

    it("parses a valid genesis object created event", () => {
        expect(
            parseGenesisObjectCreatedEvent({
                object_id: MAIN_POOL_ID,
                object_kind: 3,
                created_at_ms: "42",
            }),
        ).toEqual({
            objectId: MAIN_POOL_ID,
            objectKind: 3,
            createdAtMs: 42n,
        });
    });

    it("returns null for malformed events", () => {
        expect(parseGenesisObjectCreatedEvent({ object_id: "bad", object_kind: 3, created_at_ms: "1" })).toBeNull();
        expect(
            parseGenesisObjectCreatedEvent({ object_id: MAIN_POOL_ID, object_kind: 999, created_at_ms: "1" }),
        ).toBeNull();
        expect(
            parseGenesisObjectCreatedEvent({ object_id: MAIN_POOL_ID, object_kind: 3, created_at_ms: "x" }),
        ).toBeNull();
        expect(parseGenesisObjectCreatedEvent(null)).toBeNull();
    });
});

describe("resolveMembershipDappGenesisObjects", () => {
    it("resolves required membership dapp objects from genesis events", async () => {
        const queryEvents = vi.fn(async () => ({
            data: [
                genesisEvent(PAUSE_STATE_ID, GENESIS_OBJECT_KIND.pauseState),
                genesisEvent(MEMBERSHIP_REGISTRY_ID, GENESIS_OBJECT_KIND.membershipRegistry),
                genesisEvent(IDENTITY_REGISTRY_ID, GENESIS_OBJECT_KIND.identityRegistry),
                genesisEvent(
                    ALLOWED_RESIDENCE_CELL_REGISTRY_ID,
                    GENESIS_OBJECT_KIND.allowedResidenceCellRegistry,
                ),
                genesisEvent(CELL_COUNT_INDEX_ID, GENESIS_OBJECT_KIND.cellCountIndex),
            ],
            hasNextPage: false,
        }));

        const result = await resolveMembershipDappGenesisObjects({ queryEvents }, { packageId: PACKAGE_ID });
        expect(result).toEqual({
            kind: "ok",
            objects: {
                pauseState: PAUSE_STATE_ID,
                membershipRegistry: MEMBERSHIP_REGISTRY_ID,
                identityRegistry: IDENTITY_REGISTRY_ID,
                allowedResidenceCellRegistry: ALLOWED_RESIDENCE_CELL_REGISTRY_ID,
                cellCountIndex: CELL_COUNT_INDEX_ID,
            },
        });
    });

    it("fails closed when a required object kind is missing", async () => {
        const queryEvents = vi.fn(async () => ({
            data: [
                genesisEvent(PAUSE_STATE_ID, GENESIS_OBJECT_KIND.pauseState),
                genesisEvent(MEMBERSHIP_REGISTRY_ID, GENESIS_OBJECT_KIND.membershipRegistry),
                genesisEvent(IDENTITY_REGISTRY_ID, GENESIS_OBJECT_KIND.identityRegistry),
                genesisEvent(
                    ALLOWED_RESIDENCE_CELL_REGISTRY_ID,
                    GENESIS_OBJECT_KIND.allowedResidenceCellRegistry,
                ),
            ],
            hasNextPage: false,
        }));

        const result = await resolveMembershipDappGenesisObjects({ queryEvents }, { packageId: PACKAGE_ID });
        expect(result.kind).toBe("error");
        expect(result.message).toContain("cellCountIndex");
        expect(result.message).toContain("14");
    });

    it("fails closed when the client cannot query events", async () => {
        const result = await resolveMembershipDappGenesisObjects({}, { packageId: PACKAGE_ID });
        expect(result).toEqual({
            kind: "error",
            message: "A queryEvents-capable Sui client is required to resolve genesis objects.",
        });
    });

    it("returns an error result for invalid package ids", async () => {
        const queryEvents = vi.fn();
        const result = await resolveMembershipDappGenesisObjects({ queryEvents }, { packageId: "not-a-package" });
        expect(result.kind).toBe("error");
        expect(queryEvents).not.toHaveBeenCalled();
    });

    it("returns an error result for query errors", async () => {
        const queryEvents = vi.fn(async () => {
            throw new Error("rpc down");
        });
        const result = await resolveMembershipDappGenesisObjects({ queryEvents }, { packageId: PACKAGE_ID });
        expect(result).toEqual({ kind: "error", message: "rpc down" });
    });
});

describe("readGenesisObjectIds", () => {
    it("returns a map of object kind to object id from a single page", async () => {
        const queryEvents = vi.fn(async () => ({
            data: [
                genesisEvent(PAUSE_STATE_ID, GENESIS_OBJECT_KIND.pauseState),
                genesisEvent(MAIN_POOL_ID, GENESIS_OBJECT_KIND.mainPool),
                genesisEvent(OPERATIONS_POOL_ID, GENESIS_OBJECT_KIND.operationsPool),
                genesisEvent(DONOR_REGISTRY_ID, GENESIS_OBJECT_KIND.donorRegistry),
                genesisEvent(CATEGORY_REGISTRY_ID, GENESIS_OBJECT_KIND.categoryRegistry),
                genesisEvent(EARTHQUAKE_POOL_ID, GENESIS_OBJECT_KIND.earthquakePool),
            ],
            hasNextPage: false,
        }));

        const result = await readGenesisObjectIds({ queryEvents }, { packageId: PACKAGE_ID });
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") {
            return;
        }
        expect(selectGenesisObjectId(result.ids, GENESIS_OBJECT_KIND.pauseState)).toBe(PAUSE_STATE_ID);
        expect(selectGenesisObjectId(result.ids, GENESIS_OBJECT_KIND.mainPool)).toBe(MAIN_POOL_ID);
        expect(selectGenesisObjectId(result.ids, GENESIS_OBJECT_KIND.operationsPool)).toBe(
            OPERATIONS_POOL_ID,
        );
        expect(selectGenesisObjectId(result.ids, GENESIS_OBJECT_KIND.donorRegistry)).toBe(
            DONOR_REGISTRY_ID,
        );
        expect(selectGenesisObjectId(result.ids, GENESIS_OBJECT_KIND.categoryRegistry)).toBe(
            CATEGORY_REGISTRY_ID,
        );
        expect(selectGenesisObjectId(result.ids, GENESIS_OBJECT_KIND.earthquakePool)).toBe(
            EARTHQUAKE_POOL_ID,
        );
        expect(selectGenesisObjectId(result.ids, GENESIS_OBJECT_KIND.adminCap)).toBeNull();
    });

    it("keeps the record with the newest created_at_ms when a kind repeats", async () => {
        const newerMainPool = `0x${"33".repeat(32)}`;
        const queryEvents = vi.fn(async () => ({
            data: [
                genesisEvent(newerMainPool, GENESIS_OBJECT_KIND.mainPool, "2000"),
                genesisEvent(MAIN_POOL_ID, GENESIS_OBJECT_KIND.mainPool, "1000"),
            ],
            hasNextPage: false,
        }));

        const result = await readGenesisObjectIds({ queryEvents }, { packageId: PACKAGE_ID });
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") {
            return;
        }
        expect(selectGenesisObjectId(result.ids, GENESIS_OBJECT_KIND.mainPool)).toBe(newerMainPool);
    });

    it("walks across pages until the cursor is exhausted", async () => {
        const queryEvents = vi
            .fn()
            .mockResolvedValueOnce({
                data: [genesisEvent(MAIN_POOL_ID, GENESIS_OBJECT_KIND.mainPool)],
                hasNextPage: true,
                nextCursor: { txDigest: "d", eventSeq: "1" },
            })
            .mockResolvedValueOnce({
                data: [genesisEvent(OPERATIONS_POOL_ID, GENESIS_OBJECT_KIND.operationsPool)],
                hasNextPage: false,
            });

        const result = await readGenesisObjectIds({ queryEvents }, { packageId: PACKAGE_ID });
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") {
            return;
        }
        expect(selectGenesisObjectId(result.ids, GENESIS_OBJECT_KIND.mainPool)).toBe(MAIN_POOL_ID);
        expect(selectGenesisObjectId(result.ids, GENESIS_OBJECT_KIND.operationsPool)).toBe(
            OPERATIONS_POOL_ID,
        );
        expect(queryEvents).toHaveBeenCalledTimes(2);
    });

    it("fails closed when the package id is invalid", async () => {
        const queryEvents = vi.fn();
        const result = await readGenesisObjectIds({ queryEvents }, { packageId: "not-a-package" });
        expect(result.kind).toBe("error");
        expect(queryEvents).not.toHaveBeenCalled();
    });

    it("wraps query errors as an error result", async () => {
        const queryEvents = vi.fn(async () => {
            throw new Error("rpc down");
        });
        const result = await readGenesisObjectIds({ queryEvents }, { packageId: PACKAGE_ID });
        expect(result).toEqual({ kind: "error", message: "rpc down" });
    });
});
