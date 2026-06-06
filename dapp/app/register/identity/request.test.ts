import { computeWorldIdSignalHash } from "@sonari/proof-core";
import { describe, expect, it } from "vitest";
import { buildIdentitySubmitRequest } from "./request";

const REGISTRY_ID = `0x${"11".repeat(32)}`;
const MEMBERSHIP_ID = `0x${"22".repeat(32)}`;
const OWNER = `0x${"33".repeat(32)}`;
const SIGNED_STATEMENT_HASH = `0x${"44".repeat(32)}`;
// computeWorldIdSignalHash(OWNER, MEMBERSHIP_ID, SIGNED_STATEMENT_HASH)
const DERIVED_SIGNAL_HASH =
    "0x85cd1fac1b3f932eaffa68cd474e722e669cdd0d25827f3d92013c1fb4ac7943";

describe("dapp register identity request builder", () => {
    it("derives the World ID signal_hash from owner, membership, and statement", async () => {
        const request = await buildIdentitySubmitRequest(
            formData({
                identityProvider: "world_id",
                membershipId: MEMBERSHIP_ID,
                owner: OWNER,
                termsVersion: "1",
                signedStatementHash: SIGNED_STATEMENT_HASH,
                worldAppId: "app_staging_123",
                nullifierHash: "12345678901234567890",
                merkleRoot: "0xabc",
                proof: "0xproof",
                verificationLevel: "orb",
                worldIdAction: "sonari_membership_register_v1",
                rawKycImage: "data:image/png;base64,raw-pii",
            }),
            REGISTRY_ID,
        );

        expect(request).toEqual({
            registry_id: REGISTRY_ID,
            membership_id: MEMBERSHIP_ID,
            owner: OWNER,
            provider: "world_id",
            terms_version: 1,
            signed_statement_hash: SIGNED_STATEMENT_HASH,
            world_id: {
                world_app_id: "app_staging_123",
                nullifier_hash: "12345678901234567890",
                merkle_root: "0xabc",
                proof: "0xproof",
                verification_level: "orb",
                action: "sonari_membership_register_v1",
                signal_hash: DERIVED_SIGNAL_HASH,
            },
        });
        expect(JSON.stringify(request)).not.toContain("rawKycImage");
    });

    it("binds signal_hash to the shared proof-core derivation", async () => {
        const request = await buildIdentitySubmitRequest(
            worldIdForm(),
            REGISTRY_ID,
        );

        expect(request.world_id?.signal_hash).toBe(
            await computeWorldIdSignalHash(OWNER, MEMBERSHIP_ID, SIGNED_STATEMENT_HASH),
        );
    });

    it("never trusts a signalHash form value", async () => {
        const request = await buildIdentitySubmitRequest(
            worldIdForm({ signalHash: `0x${"55".repeat(32)}` }),
            REGISTRY_ID,
        );

        expect(request.world_id?.signal_hash).toBe(DERIVED_SIGNAL_HASH);
    });

    it("omits world_id for KYC requests", async () => {
        const request = await buildIdentitySubmitRequest(
            formData({
                identityProvider: "kyc",
                membershipId: MEMBERSHIP_ID,
                owner: OWNER,
                termsVersion: "2",
                signedStatementHash: SIGNED_STATEMENT_HASH,
                proof: "0xproof",
            }),
            REGISTRY_ID,
        );

        expect(request).toEqual({
            registry_id: REGISTRY_ID,
            membership_id: MEMBERSHIP_ID,
            owner: OWNER,
            provider: "kyc",
            terms_version: 2,
            signed_statement_hash: SIGNED_STATEMENT_HASH,
        });
        expect("world_id" in request).toBe(false);
    });

    it("rejects malformed form values before POST", async () => {
        await expect(
            buildIdentitySubmitRequest(
                formData({
                    identityProvider: "world_id",
                    membershipId: "",
                    owner: OWNER,
                    termsVersion: "1",
                    signedStatementHash: SIGNED_STATEMENT_HASH,
                }),
                REGISTRY_ID,
            ),
        ).rejects.toThrow("membershipId is required");

        await expect(
            buildIdentitySubmitRequest(
                formData({
                    identityProvider: "kyc",
                    membershipId: MEMBERSHIP_ID,
                    owner: OWNER,
                    termsVersion: "1.5",
                    signedStatementHash: SIGNED_STATEMENT_HASH,
                }),
                REGISTRY_ID,
            ),
        ).rejects.toThrow("termsVersion must be a safe unsigned integer");
    });
});

function worldIdForm(extra: Record<string, string> = {}): {
    get(name: string): string | null;
} {
    return formData({
        identityProvider: "world_id",
        membershipId: MEMBERSHIP_ID,
        owner: OWNER,
        termsVersion: "1",
        signedStatementHash: SIGNED_STATEMENT_HASH,
        worldAppId: "app_staging_123",
        nullifierHash: "12345678901234567890",
        merkleRoot: "0xabc",
        proof: "0xproof",
        verificationLevel: "orb",
        worldIdAction: "sonari_membership_register_v1",
        ...extra,
    });
}

function formData(values: Record<string, string>): { get(name: string): string | null } {
    return {
        get(name: string): string | null {
            return values[name] ?? null;
        },
    };
}
