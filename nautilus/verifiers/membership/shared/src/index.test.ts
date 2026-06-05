import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    canonicalWorldIdNullifier,
    computeKycDuplicateKeyHash,
    computeWorldIdDuplicateKeyHash,
    encodeIdentityVerificationResultBcsHex,
    IDENTITY_PROVIDER_BCS,
    IDENTITY_RESULT_FIELD_ORDER,
    IDENTITY_RESULT_INTENT,
    type IdentityVerificationResult,
} from "./index.js";

interface IdentityResultVectors {
    readonly schema: "sonari.identity_verification_result.bcs";
    readonly version: 1;
    readonly field_order: readonly string[];
    readonly provider_enum: typeof IDENTITY_PROVIDER_BCS;
    readonly signing_policy: IdentityResultSigningPolicy;
    readonly vectors: readonly IdentityResultVector[];
}

interface IdentityResultSigningPolicy {
    readonly verified_true_is_signable: true;
    readonly verified_false_is_signable: false;
    readonly unsigned_statuses_must_not_include: readonly [
        "payload_bcs_hex",
        "signature",
        "public_key",
    ];
}

interface IdentityResultVector {
    readonly case_id: string;
    readonly source_fixture: string;
    readonly result: IdentityVerificationResult;
    readonly payload_bcs_hex: string;
}

function readIdentityFixture(name: string): IdentityVerificationResult {
    const fixtureUrl = new URL(`../../fixtures/identity/${name}.json`, import.meta.url);
    return JSON.parse(readFileSync(fixtureUrl, "utf8")) as IdentityVerificationResult;
}

function readIdentityFixtureRecord(name: string): Record<string, unknown> {
    const fixtureUrl = new URL(`../../fixtures/identity/${name}.json`, import.meta.url);
    return JSON.parse(readFileSync(fixtureUrl, "utf8")) as Record<string, unknown>;
}

function readIdentityResultVectors(): IdentityResultVectors {
    const vectorsUrl = new URL(
        "../../../../../schemas/examples/identity_result_vectors.json",
        import.meta.url,
    );
    return JSON.parse(readFileSync(vectorsUrl, "utf8")) as IdentityResultVectors;
}

function readIdentityResultVector(caseId: string): IdentityResultVector {
    const vector = readIdentityResultVectors().vectors.find(
        (candidate) => candidate.case_id === caseId,
    );
    if (vector === undefined) {
        throw new Error(`Missing identity result vector: ${caseId}`);
    }
    return vector;
}

describe("IdentityVerificationResult", () => {
    const worldIdSuccessVector = readIdentityResultVector("world_id_success_v1");
    const identityResultFixture = worldIdSuccessVector.result;

    it("matches the target signed identity result shape", () => {
        expect(identityResultFixture.verified).toBe(true);
        expect(identityResultFixture.verifier_family).toBe("identity");
        expect(worldIdSuccessVector.source_fixture).toBe(
            "nautilus/verifiers/membership/fixtures/identity/world_id_success.json",
        );
    });

    it("pins the golden vector metadata and signing policy", () => {
        const vectors = readIdentityResultVectors();

        expect(vectors.schema).toBe("sonari.identity_verification_result.bcs");
        expect(vectors.version).toBe(1);
        expect(vectors.signing_policy).toEqual({
            verified_true_is_signable: true,
            verified_false_is_signable: false,
            unsigned_statuses_must_not_include: ["payload_bcs_hex", "signature", "public_key"],
        });
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
        expect(IDENTITY_RESULT_FIELD_ORDER).toEqual(readIdentityResultVectors().field_order);
    });

    it("pins provider enum values to the golden vector", () => {
        expect(IDENTITY_PROVIDER_BCS).toEqual(readIdentityResultVectors().provider_enum);
    });

    it("encodes the signed payload to fixed BCS hex", () => {
        expect(encodeIdentityVerificationResultBcsHex(identityResultFixture)).toBe(
            worldIdSuccessVector.payload_bcs_hex,
        );
    });

    it("encodes every golden vector result to its payload hex", () => {
        for (const vector of readIdentityResultVectors().vectors) {
            expect(encodeIdentityVerificationResultBcsHex(vector.result), vector.case_id).toBe(
                vector.payload_bcs_hex,
            );
        }
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
        expect(worldId).toEqual(worldIdSuccessVector.result);
        expect(worldId.duplicate_key_hash).toBe(
            computeWorldIdDuplicateKeyHash({
                world_app_id: "app_staging_123",
                action: "sonari_membership_register_v1",
                nullifier: "12345678901234567890",
            }),
        );
        expect(encodeIdentityVerificationResultBcsHex(worldId)).toBe(
            worldIdSuccessVector.payload_bcs_hex,
        );
    });

    it("loads KYC and World ID reject fixtures", () => {
        const kyc = readIdentityFixture("kyc_reject");
        const worldId = readIdentityFixture("world_id_reject");
        const kycRecord = readIdentityFixtureRecord("kyc_reject");
        const worldIdRecord = readIdentityFixtureRecord("world_id_reject");

        expect(kyc.provider).toBe("kyc");
        expect(kyc.verified).toBe(false);
        expect(kycRecord).not.toHaveProperty("payload_bcs_hex");
        expect(kycRecord).not.toHaveProperty("signature");
        expect(kycRecord).not.toHaveProperty("public_key");
        expect(kyc.terms_version).toBe(1);
        expect(kyc.evidence_hash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(kyc.signed_statement_hash).toMatch(/^0x[0-9a-f]{64}$/);

        expect(worldId.provider).toBe("world_id");
        expect(worldId.verified).toBe(false);
        expect(worldIdRecord).not.toHaveProperty("payload_bcs_hex");
        expect(worldIdRecord).not.toHaveProperty("signature");
        expect(worldIdRecord).not.toHaveProperty("public_key");
        expect(worldId.terms_version).toBe(1);
        expect(worldId.evidence_hash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(worldId.signed_statement_hash).toMatch(/^0x[0-9a-f]{64}$/);
    });
});
