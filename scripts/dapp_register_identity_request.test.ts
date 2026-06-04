import { describe, expect, it } from "vitest";
import { buildIdentitySubmitRequest } from "../dapp/app/register/identity/request.js";

describe("dapp register identity request builder", () => {
    it("builds the documented World ID SubmitVerification request shape", () => {
        const request = buildIdentitySubmitRequest(
            formData({
                identityProvider: "world_id",
                membershipId: `0x${"22".repeat(32)}`,
                owner: `0x${"33".repeat(32)}`,
                termsVersion: "1",
                signedStatementHash: `0x${"44".repeat(32)}`,
                worldAppId: "app_staging_123",
                nullifierHash: "12345678901234567890",
                merkleRoot: "0xabc",
                proof: "0xproof",
                verificationLevel: "orb",
                worldIdAction: "sonari_membership_register_v1",
                signalHash: `0x${"55".repeat(32)}`,
                rawKycImage: "data:image/png;base64,raw-pii",
            }),
            `0x${"11".repeat(32)}`,
        );

        expect(request).toEqual({
            registry_id: `0x${"11".repeat(32)}`,
            membership_id: `0x${"22".repeat(32)}`,
            owner: `0x${"33".repeat(32)}`,
            provider: "world_id",
            terms_version: 1,
            signed_statement_hash: `0x${"44".repeat(32)}`,
            world_id: {
                world_app_id: "app_staging_123",
                nullifier_hash: "12345678901234567890",
                merkle_root: "0xabc",
                proof: "0xproof",
                verification_level: "orb",
                action: "sonari_membership_register_v1",
                signal_hash: `0x${"55".repeat(32)}`,
            },
        });
        expect(JSON.stringify(request)).not.toContain("rawKycImage");
    });

    it("omits world_id for KYC requests", () => {
        const request = buildIdentitySubmitRequest(
            formData({
                identityProvider: "kyc",
                membershipId: `0x${"22".repeat(32)}`,
                owner: `0x${"33".repeat(32)}`,
                termsVersion: "2",
                signedStatementHash: `0x${"44".repeat(32)}`,
                proof: "0xproof",
            }),
            `0x${"11".repeat(32)}`,
        );

        expect(request).toEqual({
            registry_id: `0x${"11".repeat(32)}`,
            membership_id: `0x${"22".repeat(32)}`,
            owner: `0x${"33".repeat(32)}`,
            provider: "kyc",
            terms_version: 2,
            signed_statement_hash: `0x${"44".repeat(32)}`,
        });
        expect("world_id" in request).toBe(false);
    });

    it("rejects malformed form values before POST", () => {
        expect(() =>
            buildIdentitySubmitRequest(
                formData({
                    identityProvider: "world_id",
                    membershipId: "",
                    owner: `0x${"33".repeat(32)}`,
                    termsVersion: "1",
                    signedStatementHash: `0x${"44".repeat(32)}`,
                }),
                `0x${"11".repeat(32)}`,
            ),
        ).toThrow("membershipId is required");

        expect(() =>
            buildIdentitySubmitRequest(
                formData({
                    identityProvider: "kyc",
                    membershipId: `0x${"22".repeat(32)}`,
                    owner: `0x${"33".repeat(32)}`,
                    termsVersion: "1.5",
                    signedStatementHash: `0x${"44".repeat(32)}`,
                }),
                `0x${"11".repeat(32)}`,
            ),
        ).toThrow("termsVersion must be a safe unsigned integer");
    });
});

function formData(values: Record<string, string>): { get(name: string): string | null } {
    return {
        get(name: string): string | null {
            return values[name] ?? null;
        },
    };
}
