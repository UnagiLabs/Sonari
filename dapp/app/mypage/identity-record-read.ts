import { bcs } from "@mysten/sui/bcs";
import { deriveDynamicFieldID } from "@mysten/sui/utils";

export interface IdentityRecordObject {
    readonly objectId: string;
    readonly json: Record<string, unknown> | null;
}

export interface IdentityRecordClient {
    getObjects(input: {
        objectIds: string[];
        include: { json: true };
    }): Promise<{ objects: ReadonlyArray<IdentityRecordObject | Error> }>;
}

export interface IdentityRecordData {
    readonly providerMask: number;
    readonly verifiedAtMs: number;
    readonly expiresAtMs: number;
    readonly isVerified: boolean;
}

/**
 * Fetch the IdentityVerificationRecord dynamic field from IdentityRegistry.
 *
 * The field key is `0x2::object::ID` (= membershipId), BCS-encoded as 32 bytes.
 * Returns null when the record is absent, the network fails, or fields are malformed.
 */
export async function readIdentityRecord(
    client: IdentityRecordClient,
    registryId: string,
    membershipId: string,
    nowMs: number,
): Promise<IdentityRecordData | null> {
    if (registryId.length === 0 || membershipId.length === 0) {
        return null;
    }

    let fieldId: string;
    try {
        const keyBytes = bcs.Address.serialize(membershipId).toBytes();
        fieldId = deriveDynamicFieldID(registryId, "0x2::object::ID", keyBytes);
    } catch {
        return null;
    }

    let item: IdentityRecordObject | Error | undefined;
    try {
        const response = await client.getObjects({
            objectIds: [fieldId],
            include: { json: true },
        });
        item = response.objects[0];
    } catch {
        return null;
    }

    if (item === undefined || item instanceof Error || item.json === null) {
        return null;
    }

    const raw = item.json.value;
    if (!isRecord(raw)) {
        return null;
    }

    const providerMask = parseU8(raw.provider_mask);
    const verifiedAtMs = parseU64(raw.verified_at_ms);
    const expiresAtMs = parseU64(raw.expires_at_ms);

    if (providerMask === null || verifiedAtMs === null || expiresAtMs === null) {
        return null;
    }

    return {
        providerMask,
        verifiedAtMs,
        expiresAtMs,
        isVerified: providerMask !== 0 && nowMs < expiresAtMs,
    };
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function parseU8(raw: unknown): number | null {
    const n = toNumber(raw);
    if (n === null || !Number.isInteger(n) || n < 0 || n > 255) {
        return null;
    }
    return n;
}

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
    if (typeof raw === "string" && raw.trim().length > 0) {
        const parsed = Number(raw);
        if (!Number.isNaN(parsed)) {
            return parsed;
        }
    }
    return null;
}
