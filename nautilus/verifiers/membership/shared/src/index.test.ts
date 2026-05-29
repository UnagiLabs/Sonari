import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    canonicalWorldIdNullifier,
    computeKycDuplicateKeyHash,
    computeWorldIdDuplicateKeyHash,
    encodeIdentityVerificationResultBcsHex,
    IDENTITY_RESULT_FIELD_ORDER,
    IDENTITY_RESULT_INTENT,
    type IdentityVerificationResult,
} from "./index.js";

const identityResultFixture = {
    intent: IDENTITY_RESULT_INTENT,
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

function readIdentityFixture(name: string): IdentityVerificationResult {
    const fixtureUrl = new URL(`../../fixtures/identity/${name}.json`, import.meta.url);
    return JSON.parse(readFileSync(fixtureUrl, "utf8")) as IdentityVerificationResult;
}

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

    it("rejects non-identity signed payload intents", () => {
        expect(() =>
            encodeIdentityVerificationResultBcsHex({
                ...identityResultFixture,
                intent: "SONARI_EARTHQUAKE_ORACLE",
            }),
        ).toThrow(`intent must be ${IDENTITY_RESULT_INTENT}`);
    });

    it("rejects raw personal data fields", () => {
        expect(() =>
            encodeIdentityVerificationResultBcsHex({
                ...identityResultFixture,
                kyc_document_image: "ipfs://raw-document",
            }),
        ).toThrow("Unexpected identity result field: kyc_document_image");
    });

    it("pins the KYC duplicate key hash rule", () => {
        expect(
            computeKycDuplicateKeyHash({
                provider_id: "sumsub",
                provider_user_unique_id: "applicant-123",
            }),
        ).toBe("0x4957d2bb4adcf6295386f9bb1563b95ee9d34555c47604f6dc1e64614007ec66");
    });

    it("pins the World ID duplicate key hash rule", () => {
        expect(
            computeWorldIdDuplicateKeyHash({
                world_app_id: "app_staging_123",
                action: "sonari_membership_register_v1",
                nullifier: "12345678901234567890",
            }),
        ).toBe("0xb9dabcfc937c5422b28ddd2db18466a02c1f9fadb5637d120a3a455e23e88a74");
    });

    it("canonicalizes equivalent World ID nullifier formats before hashing", () => {
        const decimal = computeWorldIdDuplicateKeyHash({
            world_app_id: "app_staging_123",
            action: "sonari_membership_register_v1",
            nullifier: "12345678901234567890",
        });
        const decimalWithZeroes = computeWorldIdDuplicateKeyHash({
            world_app_id: "app_staging_123",
            action: "sonari_membership_register_v1",
            nullifier: "00012345678901234567890",
        });
        const hex = computeWorldIdDuplicateKeyHash({
            world_app_id: "app_staging_123",
            action: "sonari_membership_register_v1",
            nullifier: "0xAB54A98CEB1F0AD2",
        });
        const upperPrefixHex = computeWorldIdDuplicateKeyHash({
            world_app_id: "app_staging_123",
            action: "sonari_membership_register_v1",
            nullifier: "0XAB54A98CEB1F0AD2",
        });

        expect(decimalWithZeroes).toBe(decimal);
        expect(hex).toBe(decimal);
        expect(upperPrefixHex).toBe(decimal);
        expect(canonicalWorldIdNullifier("0xAB54A98CEB1F0AD2")).toBe("12345678901234567890");
        expect(canonicalWorldIdNullifier("0XAB54A98CEB1F0AD2")).toBe("12345678901234567890");
    });

    it("loads KYC and World ID success fixtures", () => {
        const kyc = readIdentityFixture("kyc_success");
        const worldId = readIdentityFixture("world_id_success");

        expect(kyc.provider).toBe("kyc");
        expect(kyc.verified).toBe(true);
        expect(kyc.duplicate_key_hash).toBe(
            computeKycDuplicateKeyHash({
                provider_id: "sumsub",
                provider_user_unique_id: "applicant-123",
            }),
        );
        expect(encodeIdentityVerificationResultBcsHex(kyc)).toMatch(/^0x[0-9a-f]+$/);

        expect(worldId.provider).toBe("world_id");
        expect(worldId.verified).toBe(true);
        expect(worldId.duplicate_key_hash).toBe(
            computeWorldIdDuplicateKeyHash({
                world_app_id: "app_staging_123",
                action: "sonari_membership_register_v1",
                nullifier: "12345678901234567890",
            }),
        );
        expect(encodeIdentityVerificationResultBcsHex(worldId)).toMatch(/^0x[0-9a-f]+$/);
    });

    it("loads KYC and World ID reject fixtures", () => {
        const kyc = readIdentityFixture("kyc_reject");
        const worldId = readIdentityFixture("world_id_reject");

        expect(kyc.provider).toBe("kyc");
        expect(kyc.verified).toBe(false);
        expect(kyc.terms_version).toBe(1);
        expect(kyc.evidence_hash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(kyc.signed_statement_hash).toMatch(/^0x[0-9a-f]{64}$/);

        expect(worldId.provider).toBe("world_id");
        expect(worldId.verified).toBe(false);
        expect(worldId.terms_version).toBe(1);
        expect(worldId.evidence_hash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(worldId.signed_statement_hash).toMatch(/^0x[0-9a-f]{64}$/);
    });
});
