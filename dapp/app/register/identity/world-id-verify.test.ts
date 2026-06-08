/**
 * Unit tests for world-id-verify.ts pure logic.
 *
 * All functions tested here are pure / injectable (fetch is passed as
 * argument) so no jsdom or React testing library is needed.
 *
 * skip/cancel/error/success coverage matrix:
 *   success      – interpretWorldIdResult ok:true path
 *   cancellation – mapWorldIdError("user_rejected") neutral re-try message
 *   error        – mapWorldIdError("invalid_rp_signature"), mapWorldIdError("generic_error")
 *   skip         – WorldIdVerifyButton does not force verification;
 *                  the parent page controls submit gating independently.
 *                  No pure-logic assertion is needed here; this is by design.
 */
import { describe, expect, it, vi } from "vitest";
import { WORLD_ID_ACTION } from "./world-id-action";
import {
    buildRpContext,
    interpretWorldIdResult,
    mapWorldIdError,
    requestRpSignature,
    shortNullifierFingerprint,
    type RpSignature,
} from "./world-id-verify";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_IDKIT_RESPONSE = {
    protocol_version: "4.0",
    nonce: "nonce-abc",
    action: WORLD_ID_ACTION,
    environment: "staging",
    user_presence_completed: false,
    responses: [
        {
            identifier: "proof_of_human",
            signal_hash: "0x004c584cd5e136507a762e7bc3bdd3f2e2535f5d32a7c6f343e17377886cca47",
            proof: ["0x01", "0x02"],
            nullifier: "0xdeadbeefcafe1234",
            issuer_schema_id: 1,
            expires_at_min: 1_780_000_000,
        },
    ],
};

const VALID_RP_SIGNATURE: RpSignature = {
    sig: "sig-abc",
    nonce: "nonce-xyz",
    createdAt: 1_700_000_000,
    expiresAt: 1_700_003_600,
};

// ---------------------------------------------------------------------------
// requestRpSignature
// ---------------------------------------------------------------------------

describe("requestRpSignature", () => {
    it("returns RpSignature on successful fetch", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                sig: "sig-abc",
                nonce: "nonce-xyz",
                createdAt: 1_700_000_000,
                expiresAt: 1_700_003_600,
            }),
        });

        const result = await requestRpSignature("sonari_action", mockFetch as typeof fetch);

        expect(result).toEqual<RpSignature>({
            sig: "sig-abc",
            nonce: "nonce-xyz",
            createdAt: 1_700_000_000,
            expiresAt: 1_700_003_600,
        });
        expect(mockFetch).toHaveBeenCalledWith("/api/world-id/rp-signature", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "sonari_action" }),
        });
    });

    it("throws when response is not ok", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            json: async () => ({}),
        });

        await expect(
            requestRpSignature("sonari_action", mockFetch as typeof fetch),
        ).rejects.toThrow("Failed to obtain World ID signature");
    });

    it("throws when response JSON is missing sig", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                nonce: "nonce-xyz",
                createdAt: 1_700_000_000,
                expiresAt: 1_700_003_600,
                // sig is missing
            }),
        });

        await expect(
            requestRpSignature("sonari_action", mockFetch as typeof fetch),
        ).rejects.toThrow();
    });

    it("throws when response JSON is missing nonce", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                sig: "sig-abc",
                // nonce is missing
                createdAt: 1_700_000_000,
                expiresAt: 1_700_003_600,
            }),
        });

        await expect(
            requestRpSignature("sonari_action", mockFetch as typeof fetch),
        ).rejects.toThrow();
    });

    it("throws when createdAt is not a number", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                sig: "sig-abc",
                nonce: "nonce-xyz",
                createdAt: "not-a-number",
                expiresAt: 1_700_003_600,
            }),
        });

        await expect(
            requestRpSignature("sonari_action", mockFetch as typeof fetch),
        ).rejects.toThrow();
    });

    it("throws when expiresAt is not a number", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                sig: "sig-abc",
                nonce: "nonce-xyz",
                createdAt: 1_700_000_000,
                expiresAt: null,
            }),
        });

        await expect(
            requestRpSignature("sonari_action", mockFetch as typeof fetch),
        ).rejects.toThrow();
    });
});

// ---------------------------------------------------------------------------
// buildRpContext
// ---------------------------------------------------------------------------

describe("buildRpContext", () => {
    it("builds a correct RpContext from rpId and signature", () => {
        const ctx = buildRpContext("rp_test123", VALID_RP_SIGNATURE);

        expect(ctx).toEqual({
            rp_id: "rp_test123",
            nonce: "nonce-xyz",
            created_at: 1_700_000_000,
            expires_at: 1_700_003_600,
            signature: "sig-abc",
        });
    });
});

// ---------------------------------------------------------------------------
// interpretWorldIdResult
// ---------------------------------------------------------------------------

describe("interpretWorldIdResult", () => {
    it("returns ok:true with idkitResponse for a valid proof_of_human response", () => {
        const result = interpretWorldIdResult(VALID_IDKIT_RESPONSE);

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.idkitResponse).toEqual(VALID_IDKIT_RESPONSE);
        }
    });

    it("returns ok:false for non-Orb identifier (e.g. selfie)", () => {
        const badResponse = {
            ...VALID_IDKIT_RESPONSE,
            responses: [{ ...VALID_IDKIT_RESPONSE.responses[0], identifier: "selfie" }],
        };

        const result = interpretWorldIdResult(badResponse);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.message.length).toBeGreaterThan(0);
        }
    });

    it("returns ok:false for non-Orb issuer_schema_id (e.g. 11 = selfie)", () => {
        const badResponse = {
            ...VALID_IDKIT_RESPONSE,
            responses: [{ ...VALID_IDKIT_RESPONSE.responses[0], issuer_schema_id: 11 }],
        };

        const result = interpretWorldIdResult(badResponse);

        expect(result.ok).toBe(false);
    });

    it("returns ok:false for null input", () => {
        const result = interpretWorldIdResult(null);

        expect(result.ok).toBe(false);
    });

    it("returns ok:false for a plain string", () => {
        const result = interpretWorldIdResult("bad");

        expect(result.ok).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// mapWorldIdError
// ---------------------------------------------------------------------------

describe("mapWorldIdError", () => {
    it("maps user_rejected to a neutral re-try message (cancellation path)", () => {
        const msg = mapWorldIdError("user_rejected");

        // Must be non-empty and neutral (not blaming the user)
        expect(msg.length).toBeGreaterThan(0);
        expect(msg.toLowerCase()).toContain("try again");
    });

    it("maps cancelled to a neutral re-try message", () => {
        const msg = mapWorldIdError("cancelled");

        expect(msg.length).toBeGreaterThan(0);
        expect(msg.toLowerCase()).toContain("try again");
    });

    it("maps timeout to a neutral re-try message", () => {
        const msg = mapWorldIdError("timeout");

        expect(msg.length).toBeGreaterThan(0);
        expect(msg.toLowerCase()).toContain("try again");
    });

    it("maps credential_unavailable to an alternative-method message", () => {
        const msg = mapWorldIdError("credential_unavailable");

        expect(msg.length).toBeGreaterThan(0);
    });

    it("maps world_id_4_not_available to an alternative-method message", () => {
        const msg = mapWorldIdError("world_id_4_not_available");

        expect(msg.length).toBeGreaterThan(0);
    });

    it("maps user_presence_failed to an alternative-method message", () => {
        const msg = mapWorldIdError("user_presence_failed");

        expect(msg.length).toBeGreaterThan(0);
    });

    it("maps nullifier_replayed to an already-verified message", () => {
        const msg = mapWorldIdError("nullifier_replayed");

        expect(msg.length).toBeGreaterThan(0);
        expect(msg.toLowerCase()).toMatch(/verified|already/);
    });

    it("maps max_verifications_reached to an already-verified message", () => {
        const msg = mapWorldIdError("max_verifications_reached");

        expect(msg.length).toBeGreaterThan(0);
        expect(msg.toLowerCase()).toMatch(/verified|already/);
    });

    it("maps invalid_rp_signature to a configuration/backend message", () => {
        const msg = mapWorldIdError("invalid_rp_signature");

        expect(msg.length).toBeGreaterThan(0);
        // Should suggest trying later or contacting support
        expect(msg.toLowerCase()).toMatch(/later|support|misconfigured|configured/);
    });

    it("maps unknown_rp to a configuration/backend message", () => {
        const msg = mapWorldIdError("unknown_rp");

        expect(msg.length).toBeGreaterThan(0);
    });

    it("maps generic_error to a generic retry message", () => {
        const msg = mapWorldIdError("generic_error");

        expect(msg.length).toBeGreaterThan(0);
    });

    it("maps an unknown error code to a generic retry message", () => {
        const msg = mapWorldIdError("some_future_unknown_code");

        expect(msg.length).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// shortNullifierFingerprint
// ---------------------------------------------------------------------------

describe("shortNullifierFingerprint", () => {
    it("shortens a long nullifier", () => {
        const nullifier = "0x" + "a".repeat(60);
        const fingerprint = shortNullifierFingerprint(nullifier);

        // Must be shorter than the original
        expect(fingerprint.length).toBeLessThan(nullifier.length);
    });

    it("does not include the full nullifier text in the shortened form", () => {
        const nullifier = "0x" + "a".repeat(60);
        const fingerprint = shortNullifierFingerprint(nullifier);

        expect(fingerprint).not.toBe(nullifier);
        // Does not equal the full string
        expect(fingerprint.length).toBeLessThan(nullifier.length);
    });

    it("returns short nullifiers as-is", () => {
        const nullifier = "0x1234";
        const fingerprint = shortNullifierFingerprint(nullifier);

        expect(fingerprint).toBe(nullifier);
    });

    it("contains an ellipsis for long nullifiers", () => {
        const nullifier = "0x" + "b".repeat(60);
        const fingerprint = shortNullifierFingerprint(nullifier);

        expect(fingerprint).toContain("…");
    });
});
