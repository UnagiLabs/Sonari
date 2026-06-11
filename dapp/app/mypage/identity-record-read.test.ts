import { describe, expect, it, vi } from "vitest";
import {
    type IdentityRecordClient,
    type IdentityRecordObject,
    readIdentityRecord,
} from "./identity-record-read";

const REGISTRY_ID = `0x${"aa".repeat(32)}`;
const MEMBERSHIP_ID = `0x${"bb".repeat(32)}`;

const VALID_RECORD_JSON: Record<string, unknown> = {
    provider_mask: "2",
    verified_at_ms: "1781133754186",
    expires_at_ms: "1812669722190",
    owner: `0x${"cc".repeat(32)}`,
    terms_version: "1",
    signed_statement_hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

const EXPIRED_RECORD_JSON: Record<string, unknown> = {
    ...VALID_RECORD_JSON,
    expires_at_ms: "1000000000000",
};

function stubClient(options: {
    objects?: ReadonlyArray<IdentityRecordObject | Error>;
    error?: Error;
}): IdentityRecordClient {
    return {
        getObjects: vi.fn(() => {
            if (options.error) {
                return Promise.reject(options.error);
            }
            return Promise.resolve({ objects: options.objects ?? [] });
        }),
    };
}

function fieldJson(value: Record<string, unknown>): IdentityRecordObject {
    return {
        objectId: `0x${"dd".repeat(32)}`,
        json: { name: MEMBERSHIP_ID, value },
    };
}

describe("readIdentityRecord", () => {
    it("returns parsed record when dynamic field exists and record is not expired", async () => {
        const client = stubClient({ objects: [fieldJson(VALID_RECORD_JSON)] });
        const NOW_MS = 1800000000000;

        const result = await readIdentityRecord(client, REGISTRY_ID, MEMBERSHIP_ID, NOW_MS);

        expect(result).not.toBeNull();
        expect(result?.providerMask).toBe(2);
        expect(result?.verifiedAtMs).toBe(1781133754186);
        expect(result?.expiresAtMs).toBe(1812669722190);
        expect(result?.isVerified).toBe(true);
    });

    it("returns record with isVerified=false when record exists but is expired", async () => {
        const client = stubClient({ objects: [fieldJson(EXPIRED_RECORD_JSON)] });
        const NOW_MS = 2000000000000;

        const result = await readIdentityRecord(client, REGISTRY_ID, MEMBERSHIP_ID, NOW_MS);

        expect(result).not.toBeNull();
        expect(result?.isVerified).toBe(false);
        expect(result?.expiresAtMs).toBe(1000000000000);
    });

    it("returns null when no dynamic field object found", async () => {
        const client = stubClient({ objects: [] });

        const result = await readIdentityRecord(client, REGISTRY_ID, MEMBERSHIP_ID, Date.now());

        expect(result).toBeNull();
    });

    it("returns null when getObjects throws", async () => {
        const client = stubClient({ error: new Error("network error") });

        const result = await readIdentityRecord(client, REGISTRY_ID, MEMBERSHIP_ID, Date.now());

        expect(result).toBeNull();
    });

    it("returns null when registryId is empty", async () => {
        const client = stubClient({ objects: [fieldJson(VALID_RECORD_JSON)] });

        const result = await readIdentityRecord(client, "", MEMBERSHIP_ID, Date.now());

        expect(result).toBeNull();
    });

    it("returns null when json is null", async () => {
        const client = stubClient({
            objects: [{ objectId: `0x${"dd".repeat(32)}`, json: null }],
        });

        const result = await readIdentityRecord(client, REGISTRY_ID, MEMBERSHIP_ID, Date.now());

        expect(result).toBeNull();
    });

    it("returns null when value fields are malformed", async () => {
        const client = stubClient({
            objects: [fieldJson({ ...VALID_RECORD_JSON, provider_mask: "not-a-number" })],
        });

        const result = await readIdentityRecord(client, REGISTRY_ID, MEMBERSHIP_ID, Date.now());

        expect(result).toBeNull();
    });
});
