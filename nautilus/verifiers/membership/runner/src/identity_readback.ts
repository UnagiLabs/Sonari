import { bcs } from "@mysten/sui/bcs";
import { deriveDynamicFieldID } from "@mysten/sui/utils";

// ============================================================
// Public types
// ============================================================

export interface IdentityReadbackObject {
    objectId: string;
    json: Record<string, unknown> | null;
}

export interface IdentityRecordReadbackClient {
    getObjects(input: {
        objectIds: string[];
        include: { json: true };
    }): Promise<{ objects: Array<IdentityReadbackObject | Error> }>;
}

export interface IdentityVerificationReadback {
    readonly objectId: string;
    readonly identityVerified: boolean;
    readonly identityProviderMask: number;
    readonly identityVerifiedAtMs: number;
    readonly identityExpiresAtMs: number;
    readonly termsVersion: number;
    readonly signedStatementHash: string; // 0x-prefixed hex
}

// ============================================================
// Constants
// ============================================================

/** provider bit for World ID (matches PROVIDER_WORLD_ID in identity_registry.move) */
const WORLD_ID_PROVIDER_BIT = 2;

// ============================================================
// Main export
// ============================================================

/**
 * Read-back an IdentityVerificationRecord from the chain via two dynamic-field hops:
 *
 *  Hop 1: membership registry  dynamic_field<address, ID>  (owner → lineage id)
 *  Hop 2: identity registry    dynamic_field<0x2::object::ID, IdentityVerificationRecord>
 *
 * Returns null on any failure (missing object, parse error, network error).
 * Never throws.
 */
export async function readIdentityVerificationRecord(input: {
    client: IdentityRecordReadbackClient;
    membershipRegistryId: string;
    identityRegistryId: string;
    owner: string;
    nowMs: number;
}): Promise<IdentityVerificationReadback | null> {
    const { client, membershipRegistryId, identityRegistryId, owner, nowMs } = input;

    try {
        // ── Hop 1: owner address → lineage ID ────────────────────────────
        const hop1FieldId = deriveAddressFieldId(membershipRegistryId, owner);
        if (hop1FieldId === null) {
            return null;
        }

        const hop1Response = await client.getObjects({
            objectIds: [hop1FieldId],
            include: { json: true },
        });

        const lineageId = extractLineageId(hop1Response.objects[0]);
        if (lineageId === null) {
            return null;
        }

        // ── Hop 2: lineage ID → IdentityVerificationRecord ───────────────
        const hop2FieldId = deriveObjectIdFieldId(identityRegistryId, lineageId);
        if (hop2FieldId === null) {
            return null;
        }

        const hop2Response = await client.getObjects({
            objectIds: [hop2FieldId],
            include: { json: true },
        });

        const item = hop2Response.objects[0];
        const record = extractRecord(item);
        if (record === null) {
            return null;
        }
        const objectId = item === undefined || item instanceof Error ? hop2FieldId : item.objectId;

        // ── Parse record fields ───────────────────────────────────────────
        const providerMask = parseU8(record.provider_mask);
        const verifiedAtMs = parseU64(record.verified_at_ms);
        const expiresAtMs = parseU64(record.expires_at_ms);
        const termsVersion = parseU64(record.terms_version);
        const signedStatementHash = parseSignedHash(record.signed_statement_hash);

        if (
            providerMask === null ||
            verifiedAtMs === null ||
            expiresAtMs === null ||
            termsVersion === null ||
            signedStatementHash === null
        ) {
            return null;
        }

        const identityVerified =
            (providerMask & WORLD_ID_PROVIDER_BIT) !== 0 && nowMs < expiresAtMs;

        return {
            objectId,
            identityVerified,
            identityProviderMask: providerMask,
            identityVerifiedAtMs: verifiedAtMs,
            identityExpiresAtMs: expiresAtMs,
            termsVersion,
            signedStatementHash,
        };
    } catch {
        return null;
    }
}

// ============================================================
// Internal helpers — dynamic field ID derivation
// ============================================================

function deriveAddressFieldId(parentId: string, addrHex: string): string | null {
    try {
        const keyBytes = bcs.Address.serialize(addrHex).toBytes();
        return deriveDynamicFieldID(parentId, "address", keyBytes);
    } catch {
        return null;
    }
}

function deriveObjectIdFieldId(parentId: string, idHex: string): string | null {
    try {
        // ID is a newtype over address — same 32-byte BCS encoding
        const keyBytes = bcs.Address.serialize(idHex).toBytes();
        return deriveDynamicFieldID(parentId, "0x2::object::ID", keyBytes);
    } catch {
        return null;
    }
}

// ============================================================
// Internal helpers — JSON value extraction
// ============================================================

/**
 * Extract the lineage ID (0x hex string) from the Field<address, ID> json object.
 *
 * The fullnode JSON for Field<K,V> is roughly:
 *   { id: {...}, name: <K as json>, value: <V as json> }
 * The value for an ID field is a 0x-prefixed hex string in most cases,
 * but can also arrive as { id: "0x..." } or { bytes: "..." }.
 */
function extractLineageId(item: IdentityReadbackObject | Error | undefined): string | null {
    if (item === undefined || item instanceof Error) {
        return null;
    }
    if (item.json === null) {
        return null;
    }
    const raw = item.json.value;
    return extractHexId(raw);
}

/**
 * Extract the IdentityVerificationRecord value from the Field<ID, Record> json object.
 */
function extractRecord(
    item: IdentityReadbackObject | Error | undefined,
): Record<string, unknown> | null {
    if (item === undefined || item instanceof Error) {
        return null;
    }
    if (item.json === null) {
        return null;
    }
    const raw = item.json.value;
    if (!isRecord(raw)) {
        return null;
    }
    return raw;
}

/**
 * Try to extract a 0x-prefixed hex string from a value that may be:
 *  - a 0x hex string directly
 *  - an object with an `id`, `name`, or `bytes` string field
 */
function extractHexId(raw: unknown): string | null {
    if (typeof raw === "string") {
        if (/^0x[0-9a-fA-F]+$/.test(raw)) {
            return raw;
        }
        return null;
    }
    if (isRecord(raw)) {
        for (const key of ["id", "name", "bytes"] as const) {
            const v = raw[key];
            if (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v)) {
                return v;
            }
        }
    }
    return null;
}

// ============================================================
// Internal helpers — field value parsers
// ============================================================

/** Parse a u8 value. JSON may deliver it as number or string. */
function parseU8(raw: unknown): number | null {
    const n = toNumber(raw);
    if (n === null || !Number.isInteger(n) || n < 0 || n > 255) {
        return null;
    }
    return n;
}

/** Parse a u64 value. JSON may deliver it as number or string. */
function parseU64(raw: unknown): number | null {
    const n = toNumber(raw);
    if (n === null || !Number.isSafeInteger(n) || n < 0) {
        return null;
    }
    return n;
}

function toNumber(raw: unknown): number | null {
    if (typeof raw === "number") {
        return raw;
    }
    if (typeof raw === "string") {
        const parsed = Number(raw);
        if (!Number.isNaN(parsed)) {
            return parsed;
        }
    }
    return null;
}

/**
 * Normalise signed_statement_hash to a 0x-prefixed lowercase hex string.
 * Accepts:
 *  - number[]  (byte array from JSON)
 *  - string starting with "0x"
 */
function parseSignedHash(raw: unknown): string | null {
    if (typeof raw === "string") {
        if (/^0x[0-9a-fA-F]*$/.test(raw)) {
            return raw.toLowerCase();
        }
        // SuiGrpcClient serializes Move `vector<u8>` fields as a base64 string,
        // so a non-hex string is treated as base64-encoded bytes.
        return base64ToHex(raw);
    }
    if (Array.isArray(raw)) {
        if (!raw.every((b) => typeof b === "number" && b >= 0 && b <= 255)) {
            return null;
        }
        const hex = (raw as number[]).map((b) => b.toString(16).padStart(2, "0")).join("");
        return `0x${hex}`;
    }
    return null;
}

/**
 * Decode a canonical base64 string to a 0x-prefixed lowercase hex string.
 * Returns null when the input is not valid canonical base64.
 */
function base64ToHex(value: string): string | null {
    if (value.length === 0 || value.length % 4 !== 0) {
        return null;
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        return null;
    }
    const decoded = Buffer.from(value, "base64");
    // Reject non-canonical base64 (Buffer is lenient) by round-tripping.
    if (decoded.toString("base64") !== value) {
        return null;
    }
    return `0x${decoded.toString("hex")}`;
}

// ============================================================
// Utility
// ============================================================

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}
