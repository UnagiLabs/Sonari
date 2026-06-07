import { describe, expect, it } from "vitest";
import {
    type IdentityRecordReadbackClient,
    readIdentityVerificationRecord,
} from "../src/identity_readback.js";

// ----------------------------------------------------------------
// Fixed test addresses
// ----------------------------------------------------------------
const MEMBERSHIP_REGISTRY_ID = `0x${"11".repeat(32)}`;
const IDENTITY_REGISTRY_ID = `0x${"22".repeat(32)}`;
const OWNER_ADDR = `0x${"ab".repeat(32)}`;
const LINEAGE_ID = `0x${"cd".repeat(32)}`;
const RECORD_OBJECT_ID = `0x${"ef".repeat(32)}`;

// nowMs used as the reference timestamp
const NOW_MS = 1_000_000;
const EXPIRES_AT_FUTURE = NOW_MS + 1; // not expired
const EXPIRES_AT_PAST = NOW_MS - 1; // expired
const VERIFIED_AT_MS = NOW_MS - 100;
const TERMS_VERSION = 1;
// signed_statement_hash as 0x hex string
const SIGNED_HASH_HEX = `0x${"de".repeat(32)}`;
// signed_statement_hash as number[] (byte array representation)
const SIGNED_HASH_BYTES = Array.from({ length: 32 }, () => 0xde);
// signed_statement_hash as base64 string (how SuiGrpcClient serializes Move vector<u8>)
const SIGNED_HASH_BASE64 = Buffer.from(SIGNED_HASH_BYTES).toString("base64");

// ----------------------------------------------------------------
// Helper: build a mock IdentityRecordReadbackClient
// ----------------------------------------------------------------

function makeHop1Response(lineageValue: unknown) {
    return {
        objects: [
            {
                objectId: `0x${"99".repeat(32)}`,
                json: { id: {}, name: OWNER_ADDR, value: lineageValue },
            },
        ],
    };
}

function makeHop2Response(recordValue: unknown, objectId = RECORD_OBJECT_ID) {
    return {
        objects: [
            {
                objectId,
                json: { id: {}, name: LINEAGE_ID, value: recordValue },
            },
        ],
    };
}

function makeErrorResponse(): { objects: Array<Error> } {
    return { objects: [new Error("object not found")] };
}

function makeNullJsonResponse() {
    return { objects: [{ objectId: `0x${"00".repeat(32)}`, json: null }] };
}

/**
 * Creates a stub client that returns pre-defined responses in call order.
 */
function stubClient(
    ...responses: Array<{
        objects: Array<{ objectId: string; json: Record<string, unknown> | null } | Error>;
    }>
): IdentityRecordReadbackClient {
    let callIndex = 0;
    return {
        getObjects: async () => {
            const response = responses[callIndex];
            callIndex += 1;
            if (response === undefined) {
                throw new Error("stubClient: unexpected extra getObjects call");
            }
            return response;
        },
    };
}

function throwingClient(): IdentityRecordReadbackClient {
    return {
        getObjects: async () => {
            throw new Error("network error");
        },
    };
}

// ----------------------------------------------------------------
// Test cases
// ----------------------------------------------------------------

describe("readIdentityVerificationRecord", () => {
    it("case 1: normal success — both hops succeed, provider_mask=2 (World ID), not expired → identityVerified=true", async () => {
        // u64 values arrive as strings from JSON (common Sui behavior)
        // signed_statement_hash arrives as number[] (byte array)
        const recordValue = {
            owner: OWNER_ADDR,
            provider_mask: 2,
            verified_at_ms: String(VERIFIED_AT_MS),
            expires_at_ms: String(EXPIRES_AT_FUTURE),
            terms_version: String(TERMS_VERSION),
            signed_statement_hash: SIGNED_HASH_BYTES,
        };

        const client = stubClient(makeHop1Response(LINEAGE_ID), makeHop2Response(recordValue));

        const result = await readIdentityVerificationRecord({
            client,
            membershipRegistryId: MEMBERSHIP_REGISTRY_ID,
            identityRegistryId: IDENTITY_REGISTRY_ID,
            owner: OWNER_ADDR,
            nowMs: NOW_MS,
        });

        expect(result).not.toBeNull();
        expect(result).toMatchObject({
            objectId: RECORD_OBJECT_ID,
            identityVerified: true,
            identityProviderMask: 2,
            identityVerifiedAtMs: VERIFIED_AT_MS,
            identityExpiresAtMs: EXPIRES_AT_FUTURE,
            termsVersion: TERMS_VERSION,
            signedStatementHash: SIGNED_HASH_HEX,
        });
        // All 7 fields must be present
        // biome: avoid non-null assertion — result is asserted non-null above
        expect(Object.keys(result ?? {})).toHaveLength(7);
    });

    it("case 1b: signed_statement_hash arrives as base64 (gRPC vector<u8> encoding) → decoded to 0x hex, identityVerified=true", async () => {
        // SuiGrpcClient serializes Move `vector<u8>` fields as a base64 string,
        // not as a number[] or 0x hex string. The readback must decode it.
        const recordValue = {
            owner: OWNER_ADDR,
            provider_mask: 2,
            verified_at_ms: String(VERIFIED_AT_MS),
            expires_at_ms: String(EXPIRES_AT_FUTURE),
            terms_version: String(TERMS_VERSION),
            signed_statement_hash: SIGNED_HASH_BASE64,
        };

        const client = stubClient(makeHop1Response(LINEAGE_ID), makeHop2Response(recordValue));

        const result = await readIdentityVerificationRecord({
            client,
            membershipRegistryId: MEMBERSHIP_REGISTRY_ID,
            identityRegistryId: IDENTITY_REGISTRY_ID,
            owner: OWNER_ADDR,
            nowMs: NOW_MS,
        });

        expect(result).not.toBeNull();
        expect(result?.identityVerified).toBe(true);
        expect(result?.signedStatementHash).toBe(SIGNED_HASH_HEX);
    });

    it("case 2: stale — record exists but expires_at_ms <= nowMs → identityVerified=false", async () => {
        // signed_statement_hash arrives as 0x hex string (alternative representation)
        const recordValue = {
            owner: OWNER_ADDR,
            provider_mask: 2,
            verified_at_ms: VERIFIED_AT_MS, // number form
            expires_at_ms: EXPIRES_AT_PAST, // expired
            terms_version: TERMS_VERSION,
            signed_statement_hash: SIGNED_HASH_HEX,
        };

        const client = stubClient(makeHop1Response(LINEAGE_ID), makeHop2Response(recordValue));

        const result = await readIdentityVerificationRecord({
            client,
            membershipRegistryId: MEMBERSHIP_REGISTRY_ID,
            identityRegistryId: IDENTITY_REGISTRY_ID,
            owner: OWNER_ADDR,
            nowMs: NOW_MS,
        });

        expect(result).not.toBeNull();
        expect(result?.identityVerified).toBe(false);
        expect(result?.identityExpiresAtMs).toBe(EXPIRES_AT_PAST);
        expect(result?.signedStatementHash).toBe(SIGNED_HASH_HEX);
    });

    it("case 3: provider mismatch — provider_mask=1 (KYC only, no World ID) → identityVerified=false", async () => {
        const recordValue = {
            owner: OWNER_ADDR,
            provider_mask: 1,
            verified_at_ms: VERIFIED_AT_MS,
            expires_at_ms: EXPIRES_AT_FUTURE,
            terms_version: TERMS_VERSION,
            signed_statement_hash: SIGNED_HASH_HEX,
        };

        const client = stubClient(makeHop1Response(LINEAGE_ID), makeHop2Response(recordValue));

        const result = await readIdentityVerificationRecord({
            client,
            membershipRegistryId: MEMBERSHIP_REGISTRY_ID,
            identityRegistryId: IDENTITY_REGISTRY_ID,
            owner: OWNER_ADDR,
            nowMs: NOW_MS,
        });

        expect(result).not.toBeNull();
        expect(result?.identityVerified).toBe(false);
        expect(result?.identityProviderMask).toBe(1);
    });

    it("case 4: no record — hop2 returns Error element → null", async () => {
        const client = stubClient(makeHop1Response(LINEAGE_ID), makeErrorResponse());

        const result = await readIdentityVerificationRecord({
            client,
            membershipRegistryId: MEMBERSHIP_REGISTRY_ID,
            identityRegistryId: IDENTITY_REGISTRY_ID,
            owner: OWNER_ADDR,
            nowMs: NOW_MS,
        });

        expect(result).toBeNull();
    });

    it("case 4b: no record — hop2 returns json=null → null", async () => {
        const client = stubClient(makeHop1Response(LINEAGE_ID), makeNullJsonResponse());

        const result = await readIdentityVerificationRecord({
            client,
            membershipRegistryId: MEMBERSHIP_REGISTRY_ID,
            identityRegistryId: IDENTITY_REGISTRY_ID,
            owner: OWNER_ADDR,
            nowMs: NOW_MS,
        });

        expect(result).toBeNull();
    });

    it("case 5: owner not registered — hop1 returns Error element → null", async () => {
        const client = stubClient(makeErrorResponse());

        const result = await readIdentityVerificationRecord({
            client,
            membershipRegistryId: MEMBERSHIP_REGISTRY_ID,
            identityRegistryId: IDENTITY_REGISTRY_ID,
            owner: OWNER_ADDR,
            nowMs: NOW_MS,
        });

        expect(result).toBeNull();
    });

    it("case 5b: owner not registered — hop1 returns json=null → null", async () => {
        const client = stubClient(makeNullJsonResponse());

        const result = await readIdentityVerificationRecord({
            client,
            membershipRegistryId: MEMBERSHIP_REGISTRY_ID,
            identityRegistryId: IDENTITY_REGISTRY_ID,
            owner: OWNER_ADDR,
            nowMs: NOW_MS,
        });

        expect(result).toBeNull();
    });

    it("case 6: getObjects throws → null (exception must not propagate)", async () => {
        const result = await readIdentityVerificationRecord({
            client: throwingClient(),
            membershipRegistryId: MEMBERSHIP_REGISTRY_ID,
            identityRegistryId: IDENTITY_REGISTRY_ID,
            owner: OWNER_ADDR,
            nowMs: NOW_MS,
        });

        expect(result).toBeNull();
    });

    it("identityVerified requires BOTH provider_mask has World ID bit AND not expired", async () => {
        // provider_mask = 3 (KYC | World ID), expires_at_ms > nowMs → should be true
        const recordValue = {
            owner: OWNER_ADDR,
            provider_mask: 3,
            verified_at_ms: VERIFIED_AT_MS,
            expires_at_ms: EXPIRES_AT_FUTURE,
            terms_version: TERMS_VERSION,
            signed_statement_hash: SIGNED_HASH_HEX,
        };

        const client = stubClient(makeHop1Response(LINEAGE_ID), makeHop2Response(recordValue));

        const result = await readIdentityVerificationRecord({
            client,
            membershipRegistryId: MEMBERSHIP_REGISTRY_ID,
            identityRegistryId: IDENTITY_REGISTRY_ID,
            owner: OWNER_ADDR,
            nowMs: NOW_MS,
        });

        expect(result).not.toBeNull();
        expect(result?.identityVerified).toBe(true);
        expect(result?.identityProviderMask).toBe(3);
    });
});
