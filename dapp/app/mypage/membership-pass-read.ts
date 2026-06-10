import {
    lookupMembershipPass,
    type OwnedObjectsClient,
} from "../register/identity/membership-lookup";

/**
 * Read-only fetch of the connected wallet's `MembershipPass` SBT *contents*
 * (not just its object id) so /mypage can render the member's residence,
 * identity, and pass status.
 *
 * The id is located with the existing `lookupMembershipPass` (one pass per
 * wallet is enforced on-chain), then the object body is read via `getObjects`.
 * The client is injected so this stays unit-testable with a stub. The shape
 * mirrors the proven readback in
 * `nautilus/verifiers/membership/runner/src/identity_readback.ts`.
 */

/** Minimal fetched-object shape we depend on from `SuiGrpcClient.getObjects`. */
export interface MembershipPassReadObject {
    readonly objectId: string;
    readonly json: Record<string, unknown> | null;
}

/** Minimal client surface: the owned-object lookup plus the content fetch. */
export interface MembershipPassReadClient extends OwnedObjectsClient {
    getObjects(input: {
        objectIds: string[];
        include: { json: true };
    }): Promise<{ objects: ReadonlyArray<MembershipPassReadObject | Error> }>;
}

/**
 * Parsed `MembershipPass` fields used by /mypage.
 *
 * `homeCell` stays a string: the H3 res7 decimal exceeds
 * `Number.MAX_SAFE_INTEGER`, so converting it to a JS number would corrupt the
 * lower digits. Timestamps fit safely in a number.
 */
export interface MembershipPassData {
    readonly objectId: string;
    readonly status: number;
    readonly issuedAtMs: number;
    readonly homeCell: string;
    readonly homeCellRegisteredAtMs: number;
    readonly identityVerified: boolean;
    readonly identityProviderMask: number;
    readonly identityVerifiedAtMs: number;
    readonly identityExpiresAtMs: number;
}

export type MembershipPassReadResult =
    | { readonly kind: "ok"; readonly pass: MembershipPassData }
    | { readonly kind: "none" }
    | { readonly kind: "error"; readonly message: string };

const GENERIC_READ_ERROR = "Could not read your Membership SBT.";

export async function readMembershipPass(
    client: MembershipPassReadClient,
    owner: string,
    packageId: string,
): Promise<MembershipPassReadResult> {
    const lookup = await lookupMembershipPass(client, owner, packageId);
    if (lookup.kind === "none") {
        return { kind: "none" };
    }
    if (lookup.kind === "multiple") {
        // The contract issues one pass per wallet; surface the anomaly instead
        // of guessing which one to show.
        return { kind: "error", message: "Multiple Membership SBTs found for this wallet." };
    }
    if (lookup.kind === "error") {
        return { kind: "error", message: lookup.message };
    }

    let item: MembershipPassReadObject | Error | undefined;
    try {
        const response = await client.getObjects({
            objectIds: [lookup.membershipId],
            include: { json: true },
        });
        item = response.objects[0];
    } catch (error) {
        return { kind: "error", message: errorMessage(error) };
    }

    if (item === undefined || item instanceof Error) {
        return { kind: "error", message: GENERIC_READ_ERROR };
    }
    if (item.json === null) {
        return { kind: "error", message: GENERIC_READ_ERROR };
    }

    const pass = parseMembershipPass(item.objectId, item.json);
    if (pass === null) {
        return { kind: "error", message: GENERIC_READ_ERROR };
    }
    return { kind: "ok", pass };
}

function parseMembershipPass(
    objectId: string,
    json: Record<string, unknown>,
): MembershipPassData | null {
    const status = parseU8(json.status);
    const issuedAtMs = parseU64Number(json.issued_at_ms);
    const homeCell = parseU64String(json.home_cell);
    const homeCellRegisteredAtMs = parseU64Number(json.home_cell_registered_at_ms);
    const identityVerified = parseBool(json.identity_verified);
    const identityProviderMask = parseU8(json.identity_provider_mask);
    const identityVerifiedAtMs = parseU64Number(json.identity_verified_at_ms);
    const identityExpiresAtMs = parseU64Number(json.identity_expires_at_ms);

    if (
        status === null ||
        issuedAtMs === null ||
        homeCell === null ||
        homeCellRegisteredAtMs === null ||
        identityVerified === null ||
        identityProviderMask === null ||
        identityVerifiedAtMs === null ||
        identityExpiresAtMs === null
    ) {
        return null;
    }

    return {
        objectId,
        status,
        issuedAtMs,
        homeCell,
        homeCellRegisteredAtMs,
        identityVerified,
        identityProviderMask,
        identityVerifiedAtMs,
        identityExpiresAtMs,
    };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : GENERIC_READ_ERROR;
}

/**
 * Parse a `u64` while preserving full precision. Large values (e.g. an H3 cell)
 * are only accepted as digit strings; a number that big is already lossy, so we
 * reject it rather than store corrupted data. Small safe numbers (e.g. 0) pass.
 */
function parseU64String(raw: unknown): string | null {
    if (typeof raw === "string" && /^\d+$/.test(raw)) {
        return raw;
    }
    if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) {
        return String(raw);
    }
    return null;
}

function parseU64Number(raw: unknown): number | null {
    const n = toNumber(raw);
    if (n === null || !Number.isSafeInteger(n) || n < 0) {
        return null;
    }
    return n;
}

function parseU8(raw: unknown): number | null {
    const n = toNumber(raw);
    if (n === null || !Number.isInteger(n) || n < 0 || n > 255) {
        return null;
    }
    return n;
}

function parseBool(raw: unknown): boolean | null {
    if (typeof raw === "boolean") {
        return raw;
    }
    if (raw === "true") {
        return true;
    }
    if (raw === "false") {
        return false;
    }
    return null;
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
