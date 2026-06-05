import { describe, expect, it } from "vitest";
import {
    assertFixtureNetwork,
    buildDummyWorldIdRequest,
    buildMembershipIdentityFixtureFiles,
    buildMembershipIdentityFixtureManifest,
    DEFAULT_SIGNED_STATEMENT_HASH,
    DEFAULT_TERMS_VERSION,
    DEFAULT_WORLD_ID_SIGNAL_HASH,
    type MembershipIdentityFixtureManifestInput,
    WORLD_ID_ACTION,
} from "./membership_identity_testnet_fixture.js";

describe("membership identity testnet fixture files", () => {
    it("generates env, manifest, and dummy World ID request without secrets", () => {
        const files = buildMembershipIdentityFixtureFiles(fixtureInput());
        const manifest = JSON.parse(files.manifestJson) as unknown;
        const request = JSON.parse(files.dummyWorldIdRequestJson) as unknown;

        expect(files.envFile).toBe(
            [
                `SONARI_IDENTITY_PACKAGE_ID=${objectId("aa")}`,
                `SONARI_IDENTITY_PAUSE_STATE_ID=${objectId("11")}`,
                `SONARI_IDENTITY_REGISTRY_ID=${objectId("22")}`,
                `SONARI_MEMBERSHIP_REGISTRY_ID=${objectId("33")}`,
                `SONARI_VERIFIER_REGISTRY_ID=${objectId("44")}`,
                `SONARI_MEMBERSHIP_PASS_ID=${objectId("66")}`,
                "",
            ].join("\n"),
        );
        expect(manifest).toMatchObject({
            schema: "sonari.membership_identity.testnet_fixture",
            version: 1,
            network: "testnet",
            generated_at: "2026-06-05T00:00:00.000Z",
            sui_client_config: ".local/sonari-dev/sui_wallets/admin/sui_config.yaml",
            objects: {
                package_id: objectId("aa"),
                admin_cap_id: objectId("ab"),
                allowed_residence_cell_registry_id: objectId("55"),
                membership_pass_id: objectId("66"),
            },
        });
        expect(request).toEqual({
            registry_id: objectId("22"),
            membership_id: objectId("66"),
            owner: objectId("77"),
            provider: "world_id",
            terms_version: DEFAULT_TERMS_VERSION,
            signed_statement_hash: DEFAULT_SIGNED_STATEMENT_HASH,
            world_id: {
                world_app_id: "app_staging_123",
                nullifier_hash: "12345678901234567890",
                merkle_root: "987654321",
                proof: "0xproof",
                verification_level: "orb",
                action: WORLD_ID_ACTION,
                signal_hash: DEFAULT_WORLD_ID_SIGNAL_HASH,
            },
        });
        expect(files.manifestJson).not.toMatch(/private|secret|keystore|suiprivkey/i);
        expect(files.envFile).not.toMatch(/private|secret|keystore|suiprivkey/i);
        expect(files.dummyWorldIdRequestJson).not.toMatch(/private|secret|keystore|suiprivkey/i);
    });

    it("builds the AWS submit request from manifest smoke metadata", () => {
        const manifest = buildMembershipIdentityFixtureManifest(fixtureInput());

        expect(buildDummyWorldIdRequest(manifest)).toEqual(manifest.smoke);
    });

    it("fails closed on mainnet", () => {
        expect(() => assertFixtureNetwork("mainnet")).toThrow(
            "membership identity fixture only supports devnet or testnet",
        );
    });

    it("rejects empty object ids and mismatched smoke ids", () => {
        expect(() =>
            buildMembershipIdentityFixtureManifest({
                ...fixtureInput(),
                objects: { ...fixtureInput().objects, packageId: "" },
            }),
        ).toThrow("packageId must be a 0x-prefixed hex object id");

        expect(() =>
            buildMembershipIdentityFixtureManifest({
                ...fixtureInput(),
                smoke: { ...fixtureInput().smoke, membershipId: objectId("99") },
            }),
        ).toThrow("smoke membership_id must match SONARI_MEMBERSHIP_PASS_ID");
    });
});

function fixtureInput(): MembershipIdentityFixtureManifestInput {
    return {
        network: "testnet",
        generatedAt: "2026-06-05T00:00:00.000Z",
        suiClientConfig: ".local/sonari-dev/sui_wallets/admin/sui_config.yaml",
        objects: {
            packageId: objectId("aa"),
            adminCapId: objectId("ab"),
            pauseStateId: objectId("11"),
            identityRegistryId: objectId("22"),
            membershipRegistryId: objectId("33"),
            verifierRegistryId: objectId("44"),
            allowedResidenceCellRegistryId: objectId("55"),
            membershipPassId: objectId("66"),
        },
        smoke: {
            registryId: objectId("22"),
            membershipId: objectId("66"),
            owner: objectId("77"),
            termsVersion: DEFAULT_TERMS_VERSION,
            signedStatementHash: DEFAULT_SIGNED_STATEMENT_HASH,
            worldId: {
                worldAppId: "app_staging_123",
                nullifierHash: "12345678901234567890",
                merkleRoot: "987654321",
                proof: "0xproof",
                verificationLevel: "orb",
                action: WORLD_ID_ACTION,
                signalHash: DEFAULT_WORLD_ID_SIGNAL_HASH,
            },
        },
    };
}

function objectId(byte: string): string {
    return `0x${byte.repeat(32)}`;
}
