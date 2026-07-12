import { describe, expect, it, vi } from "vitest";
import { createClaimReadClient, type EventQueryClient } from "./claim-read-client";

// GraphQL event query を差し替えるためのモックイベントクライアント。
function makeEventClient(): EventQueryClient & { queryMoveEvents: ReturnType<typeof vi.fn> } {
    return {
        queryMoveEvents: vi.fn(async () => ({ data: [], hasNextPage: false, nextCursor: null })),
    };
}

describe("createClaimReadClient", () => {
    it("queryMoveEvents は注入した GraphQL イベントクライアントへ委譲する", async () => {
        const eventClient = makeEventClient();
        const grpc = { getObjects: vi.fn(), listOwnedObjects: vi.fn() };
        const client = createClaimReadClient(grpc, eventClient);

        const input = { type: "0x1::campaign::CampaignCreated" } as const;
        await client.queryMoveEvents(input);

        expect(eventClient.queryMoveEvents).toHaveBeenCalledTimes(1);
        expect(eventClient.queryMoveEvents).toHaveBeenCalledWith(input);
        // gRPC 側は呼ばれない。
        expect(grpc.getObjects).not.toHaveBeenCalled();
    });

    it("getObjects は gRPC クライアントへ委譲する", async () => {
        const eventClient = makeEventClient();
        const getObjects = vi.fn(async () => ({ objects: [] }));
        const grpc = { getObjects, listOwnedObjects: vi.fn() };
        const client = createClaimReadClient(grpc, eventClient);

        const input = { objectIds: ["0xabc"], include: { json: true } } as const;
        await client.getObjects(input);

        expect(getObjects).toHaveBeenCalledTimes(1);
        expect(getObjects).toHaveBeenCalledWith(input);
    });

    it("listOwnedObjects は gRPC クライアントへ委譲する", async () => {
        const eventClient = makeEventClient();
        const listOwnedObjects = vi.fn(async () => ({ objects: [] }));
        const grpc = { getObjects: vi.fn(), listOwnedObjects };
        const client = createClaimReadClient(grpc, eventClient);

        const input = { owner: "0xowner" } as const;
        await client.listOwnedObjects(input as never);

        expect(listOwnedObjects).toHaveBeenCalledTimes(1);
        expect(listOwnedObjects).toHaveBeenCalledWith(input);
    });

    it("構築時は throw しない（SSR でクライアント未準備でも 500 にしない）", () => {
        const eventClient = makeEventClient();
        // grpcClient が null / 非レコードでも構築自体は成功する。
        expect(() => createClaimReadClient(null, eventClient)).not.toThrow();
        expect(() => createClaimReadClient(undefined, eventClient)).not.toThrow();
        expect(() => createClaimReadClient({}, eventClient)).not.toThrow();
    });

    it("getObjects/listOwnedObjects は呼び出し時に検証する（未準備 grpc は call 時に throw）", async () => {
        const eventClient = makeEventClient();
        const client = createClaimReadClient(null, eventClient);

        await expect(client.getObjects({ objectIds: [], include: { json: true } })).rejects.toThrow(
            /Sui client is not available/,
        );

        // メソッドを持たないレコードは「対応していない」エラー。
        const clientNoMethods = createClaimReadClient({}, eventClient);
        await expect(
            clientNoMethods.getObjects({ objectIds: [], include: { json: true } }),
        ).rejects.toThrow(/does not support getObjects/);
    });

    it("queryMoveEvents は grpc が未準備でも動く（GraphQL 経路は独立）", async () => {
        const eventClient = makeEventClient();
        const client = createClaimReadClient(null, eventClient);

        await client.queryMoveEvents({ type: "0x1::campaign::CampaignCreated" });
        expect(eventClient.queryMoveEvents).toHaveBeenCalledTimes(1);
    });
});
