import { describe, expect, it } from "vitest";
import {
    encodeIdentityVerificationResultBcsHex,
    IDENTITY_RESULT_FIELD_ORDER,
    type IdentityVerificationResult,
} from "./index.js";

const identityResultFixture = {
    intent: "SONARI_IDENTITY_VERIFICATION_V1",
    verifier_family: "identity",
    verifier_version: 1,
    registry_id: "0x1111111111111111111111111111111111111111111111111111111111111111",
    membership_id: "0x2222222222222222222222222222222222222222222222222222222222222222",
    owner: "0x3333333333333333333333333333333333333333333333333333333333333333",
    provider: "world_id",
    verified: true,
    duplicate_key_hash: "0x4444444444444444444444444444444444444444444444444444444444444444",
    evidence_hash: "0x5555555555555555555555555555555555555555555555555555555555555555",
    issued_at_ms: 1_800_000_000_000,
    expires_at_ms: 1_831_536_000_000,
    terms_version: 1,
    signed_statement_hash: "0x6666666666666666666666666666666666666666666666666666666666666666",
} satisfies IdentityVerificationResult;

describe("IdentityVerificationResult", () => {
    it("matches the target signed identity result shape", () => {
        expect(identityResultFixture.verified).toBe(true);
        expect(identityResultFixture.verifier_family).toBe("identity");
    });

    it("pins the contract-facing field order", () => {
        expect(IDENTITY_RESULT_FIELD_ORDER).toEqual([
            "intent",
            "verifier_family",
            "verifier_version",
            "registry_id",
            "membership_id",
            "owner",
            "provider",
            "verified",
            "duplicate_key_hash",
            "evidence_hash",
            "issued_at_ms",
            "expires_at_ms",
            "terms_version",
            "signed_statement_hash",
        ]);
    });

    it("encodes the signed payload to fixed BCS hex", () => {
        expect(encodeIdentityVerificationResultBcsHex(identityResultFixture)).toBe(
            "0x1f534f4e4152495f4944454e544954595f564552494649434154494f4e5f5631086964656e74697479010000000000000011111111111111111111111111111111111111111111111111111111111111112222222222222222222222222222222222222222222222222222222222222222333333333333333333333333333333333333333333333333333333333333333302014444444444444444444444444444444444444444444444444444444444444444555555555555555555555555555555555555555555555555555555555555555500505c18a3010000007c0d70aa01000001000000000000006666666666666666666666666666666666666666666666666666666666666666",
        );
    });

    it("rejects malformed contract-facing bytes", () => {
        expect(() =>
            encodeIdentityVerificationResultBcsHex({
                ...identityResultFixture,
                duplicate_key_hash: "0x1234",
            }),
        ).toThrow("duplicate_key_hash must be a 32-byte 0x-prefixed hex string");
    });

    it("rejects raw personal data fields", () => {
        expect(() =>
            encodeIdentityVerificationResultBcsHex({
                ...identityResultFixture,
                kyc_document_image: "ipfs://raw-document",
            }),
        ).toThrow("Unexpected identity result field: kyc_document_image");
    });
});
