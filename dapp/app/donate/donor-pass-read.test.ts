import { describe, expect, it, vi } from "vitest";
import {
    type DonorPassReadClient,
    type DonorPassRegistryFieldObject,
    readDonorPassId,
    readDonorPassIdUntilVisible,
} from "./donor-pass-read";

const REGISTRY_ID = `0x${"aa".repeat(32)}`;
const DONOR_ADDRESS = `0x${"11".repeat(32)}`;
const PASS_ID = `0x${"bb".repeat(32)}`;
const DONOR_FIELD_ID = "0xa3d65f1991b0f29fdb10348219eb0ce14091a3c36b452e4d065dedf6eb562017";

function stubClient(options: {
    objects?: ReadonlyArray<DonorPassRegistryFieldObject | Error>;
    error?: Error;
}): { readonly client: DonorPassReadClient; readonly getObjects: ReturnType<typeof vi.fn> } {
    const getObjects = vi.fn(() => {
        if (options.error) {
            return Promise.reject(options.error);
        }
        return Promise.resolve({ objects: options.objects ?? [] });
    });
    return { client: { getObjects }, getObjects };
}

function fieldJson(value: unknown): DonorPassRegistryFieldObject {
    return {
        objectId: DONOR_FIELD_ID,
        json: { name: DONOR_ADDRESS, value },
    };
}

describe("readDonorPassId", () => {
    it("returns the pass id stored in the donor registry dynamic field", async () => {
        const { client } = stubClient({ objects: [fieldJson(PASS_ID)] });

        const result = await readDonorPassId(client, REGISTRY_ID, DONOR_ADDRESS);

        expect(result).toEqual({ kind: "ok", passId: PASS_ID });
    });

    it("derives the field id with the address type tag", async () => {
        const { client, getObjects } = stubClient({ objects: [fieldJson(PASS_ID)] });

        await readDonorPassId(client, REGISTRY_ID, DONOR_ADDRESS);

        expect(getObjects).toHaveBeenCalledWith({
            objectIds: [DONOR_FIELD_ID],
            include: { json: true },
        });
    });

    it("returns none only when the dynamic field object is absent", async () => {
        const { client } = stubClient({ objects: [] });

        const result = await readDonorPassId(client, REGISTRY_ID, DONOR_ADDRESS);

        expect(result).toEqual({ kind: "none" });
    });

    it("returns error when the dynamic field json is missing", async () => {
        const { client } = stubClient({
            objects: [{ objectId: DONOR_FIELD_ID, json: null }],
        });

        const result = await readDonorPassId(client, REGISTRY_ID, DONOR_ADDRESS);

        expect(result.kind).toBe("error");
    });

    it("returns error when the dynamic field value is malformed", async () => {
        const { client } = stubClient({ objects: [fieldJson({ id: PASS_ID })] });

        const result = await readDonorPassId(client, REGISTRY_ID, DONOR_ADDRESS);

        expect(result.kind).toBe("error");
    });

    it("returns error when the pass id is not a valid object id", async () => {
        const { client } = stubClient({ objects: [fieldJson("0xnot-an-object")] });

        const result = await readDonorPassId(client, REGISTRY_ID, DONOR_ADDRESS);

        expect(result.kind).toBe("error");
    });

    it("returns error when the rpc read throws", async () => {
        const { client } = stubClient({ error: new Error("rpc down") });

        const result = await readDonorPassId(client, REGISTRY_ID, DONOR_ADDRESS);

        expect(result).toEqual({ kind: "error", message: "rpc down" });
    });

    it("returns error without rpc when the donor address cannot be serialized", async () => {
        const { client, getObjects } = stubClient({ objects: [fieldJson(PASS_ID)] });

        const result = await readDonorPassId(client, REGISTRY_ID, "not-an-address");

        expect(result.kind).toBe("error");
        expect(getObjects).not.toHaveBeenCalled();
    });
});

describe("readDonorPassIdUntilVisible", () => {
    it("retries while the dynamic field is not visible yet", async () => {
        const getObjects = vi
            .fn()
            .mockResolvedValueOnce({ objects: [] })
            .mockResolvedValueOnce({ objects: [] })
            .mockResolvedValueOnce({ objects: [fieldJson(PASS_ID)] });
        const sleep = vi.fn(() => Promise.resolve());

        const result = await readDonorPassIdUntilVisible(
            { getObjects },
            REGISTRY_ID,
            DONOR_ADDRESS,
            { maxAttempts: 3, delayMs: 5, sleep },
        );

        expect(result).toEqual({ kind: "ok", passId: PASS_ID });
        expect(getObjects).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledWith(5);
    });

    it("returns none after the final attempt still cannot see the field", async () => {
        const { client, getObjects } = stubClient({ objects: [] });
        const sleep = vi.fn(() => Promise.resolve());

        const result = await readDonorPassIdUntilVisible(
            client,
            REGISTRY_ID,
            DONOR_ADDRESS,
            { maxAttempts: 2, sleep },
        );

        expect(result).toEqual({ kind: "none" });
        expect(getObjects).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledTimes(1);
    });
});
