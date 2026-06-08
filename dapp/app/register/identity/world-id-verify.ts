/**
 * Pure logic for the World ID verify flow.
 *
 * All functions are framework-agnostic and injectable (fetch is passed as
 * a parameter), making them easy to test without jsdom or React testing library.
 *
 * The React glue component (world-id-verify-button.tsx) imports from this
 * module. The separation keeps the widget thin and the logic testable.
 */
import type { RpContext } from "@worldcoin/idkit";
import { parseIdkitResponse } from "./request";

export type { RpContext };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * RP signature response from `POST /api/world-id/rp-signature`.
 */
export interface RpSignature {
    readonly sig: string;
    readonly nonce: string;
    readonly createdAt: number;
    readonly expiresAt: number;
}

// ---------------------------------------------------------------------------
// requestRpSignature
// ---------------------------------------------------------------------------

/**
 * Calls `POST /api/world-id/rp-signature` and returns the parsed signature.
 *
 * `fetchImpl` is injectable for testing (defaults to global `fetch`).
 *
 * @throws if the response is not ok, or if the JSON shape is missing required fields.
 */
export async function requestRpSignature(
    action: string,
    fetchImpl: typeof fetch = fetch,
): Promise<RpSignature> {
    const response = await fetchImpl("/api/world-id/rp-signature", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
    });

    if (!response.ok) {
        throw new Error("Failed to obtain World ID signature");
    }

    const json = (await response.json()) as unknown;

    return parseRpSignatureJson(json);
}

function parseRpSignatureJson(json: unknown): RpSignature {
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
        throw new Error("RP signature response must be an object");
    }
    const obj = json as Record<string, unknown>;

    if (typeof obj.sig !== "string" || obj.sig.length === 0) {
        throw new Error("RP signature response is missing sig");
    }
    if (typeof obj.nonce !== "string" || obj.nonce.length === 0) {
        throw new Error("RP signature response is missing nonce");
    }
    if (typeof obj.createdAt !== "number") {
        throw new Error("RP signature response createdAt must be a number");
    }
    if (typeof obj.expiresAt !== "number") {
        throw new Error("RP signature response expiresAt must be a number");
    }

    return {
        sig: obj.sig,
        nonce: obj.nonce,
        createdAt: obj.createdAt,
        expiresAt: obj.expiresAt,
    };
}

// ---------------------------------------------------------------------------
// buildRpContext
// ---------------------------------------------------------------------------

/**
 * Builds an `RpContext` object for `IDKitRequestWidget` from the RP ID and
 * the signature returned by the backend.
 */
export function buildRpContext(rpId: string, signature: RpSignature): RpContext {
    return {
        rp_id: rpId,
        nonce: signature.nonce,
        created_at: signature.createdAt,
        expires_at: signature.expiresAt,
        signature: signature.sig,
    };
}

// ---------------------------------------------------------------------------
// interpretWorldIdResult
// ---------------------------------------------------------------------------

/**
 * Validates a raw IDKit result object using `parseIdkitResponse`.
 *
 * Returns `{ ok: true, idkitResponse }` on success, or
 * `{ ok: false, message }` when validation fails (e.g., non-Orb credential).
 */
export function interpretWorldIdResult(
    result: unknown,
): { ok: true; idkitResponse: Record<string, unknown> } | { ok: false; message: string } {
    try {
        const idkitResponse = parseIdkitResponse(result);
        return { ok: true, idkitResponse };
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "World ID verification failed.";
        return { ok: false, message };
    }
}

// ---------------------------------------------------------------------------
// mapWorldIdError
// ---------------------------------------------------------------------------

/**
 * Maps an `IDKitErrorCodes` string value to a human-readable UI message.
 *
 * Groups:
 *   - user_rejected / cancelled / timeout         → neutral re-try guidance
 *   - credential_unavailable / world_id_*_not_available / user_presence_failed
 *                                                 → alternative method / try later
 *   - nullifier_replayed / max_verifications_reached
 *                                                 → already verified
 *   - invalid_rp_signature / unknown_rp / inactive_rp / timestamp_* / rp_signature_expired
 *     / invalid_rp_id_format                      → configuration / backend problem
 *   - everything else                              → generic fallback
 */
export function mapWorldIdError(code: string): string {
    switch (code) {
        case "user_rejected":
        case "cancelled":
        case "timeout":
            return "World ID verification was cancelled. You can try again.";

        case "credential_unavailable":
        case "world_id_4_not_available":
        case "world_id_3_not_available":
        case "user_presence_failed":
            return "World ID is not available on this device right now. You can use another method or add it later.";

        case "nullifier_replayed":
        case "max_verifications_reached":
            return "This World ID is already verified for Sonari.";

        case "invalid_rp_signature":
        case "unknown_rp":
        case "inactive_rp":
        case "timestamp_too_old":
        case "timestamp_too_far_in_future":
        case "invalid_timestamp":
        case "rp_signature_expired":
        case "invalid_rp_id_format":
            return "World ID is misconfigured. Please try again later or contact support.";

        default:
            return "World ID verification failed. Please try again.";
    }
}

// ---------------------------------------------------------------------------
// shortNullifierFingerprint
// ---------------------------------------------------------------------------

/**
 * Returns a short fingerprint of a nullifier for display purposes.
 * Shows the first 6 and last 4 characters joined by "…" for long values.
 * Short nullifiers (≤ 12 chars) are returned as-is.
 *
 * The full nullifier is never displayed to avoid unnecessary PII exposure.
 */
export function shortNullifierFingerprint(nullifier: string): string {
    const MIN_LENGTH = 13; // below this threshold, show as-is
    if (nullifier.length < MIN_LENGTH) {
        return nullifier;
    }
    const head = nullifier.slice(0, 6);
    const tail = nullifier.slice(-4);
    return `${head}…${tail}`;
}
