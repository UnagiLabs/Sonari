import { describe, expect, it } from "vitest";
import { validateMembershipIdentityLiveGate } from "./membership_identity_live_gate.js";

describe("membership identity live gate", () => {
    it("fails closed before live side effects when required values are missing", async () => {
        const result = await validateMembershipIdentityLiveGate({ env: {} });

        expect(result.ok).toBe(false);
        expect(result.checks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: "STACK_NAME",
                    status: "fail",
                }),
                expect.objectContaining({
                    name: "AWS_CREDENTIALS",
                    status: "fail",
                }),
                expect.objectContaining({
                    name: "RELAYER_MODE",
                    status: "fail",
                }),
                expect.objectContaining({
                    name: "RELAYER_ALLOW_SUBMIT",
                    status: "fail",
                }),
            ]),
        );
    });

    it("passes dry validation when issue 74 live close-out inputs are present", async () => {
        const result = await validateMembershipIdentityLiveGate({
            env: {
                ...completeEnv(),
                SONARI_WORLD_ID_PROOF_MODE: "real",
            },
        });

        expect(result.ok).toBe(true);
        expect(result.checks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: "TEE_ARTIFACT_SHA256",
                    status: "ok",
                }),
                expect.objectContaining({
                    name: "NITRO_ENCLAVE_IMAGE_SHA384",
                    status: "ok",
                }),
                expect.objectContaining({
                    name: "SONARI_WORLD_ID_ACTION",
                    status: "ok",
                }),
                expect.objectContaining({
                    name: "SONARI_WORLD_ID_PROOF_MODE",
                    status: "ok",
                    message: "real",
                }),
                expect.objectContaining({
                    name: "RELAYER_SUBMIT_GUARD",
                    status: "ok",
                }),
            ]),
        );
    });

    it("allows same-shape dummy World ID proof only on non-mainnet Sui networks", async () => {
        const result = await validateMembershipIdentityLiveGate({
            env: {
                ...completeEnv(),
                RELAYER_NETWORK: "devnet",
                RELAYER_GRPC_URL: "https://fullnode.devnet.sui.io:443",
                SONARI_WORLD_ID_PROOF_MODE: "dummy",
            },
        });

        expect(result.ok).toBe(true);
        expect(result.checks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: "SONARI_WORLD_ID_PROOF_MODE",
                    status: "ok",
                    message: "dummy allowed on devnet",
                }),
            ]),
        );
    });

    it("allows versioned World ID actions and rejects invalid action names", async () => {
        const custom = await validateMembershipIdentityLiveGate({
            env: {
                ...completeEnv(),
                SONARI_WORLD_ID_ACTION: "sonari_membership_register_v3",
                SONARI_WORLD_ID_PROOF_MODE: "real",
            },
        });
        expect(custom.ok).toBe(true);
        expect(custom.checks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: "SONARI_WORLD_ID_ACTION",
                    status: "ok",
                    message: "sonari_membership_register_v3",
                }),
            ]),
        );

        const invalid = await validateMembershipIdentityLiveGate({
            env: {
                ...completeEnv(),
                SONARI_WORLD_ID_ACTION: "attacker_action",
                SONARI_WORLD_ID_PROOF_MODE: "real",
            },
        });
        expect(invalid.ok).toBe(false);
        expect(invalid.checks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: "SONARI_WORLD_ID_ACTION",
                    status: "fail",
                    message: "SONARI_WORLD_ID_ACTION must match sonari_membership_register_v<N>",
                }),
            ]),
        );
    });

    it("rejects dummy World ID proof mode on mainnet", async () => {
        const result = await validateMembershipIdentityLiveGate({
            env: {
                ...completeEnv(),
                RELAYER_NETWORK: "mainnet",
                RELAYER_GRPC_URL: "https://fullnode.mainnet.sui.io:443",
                SONARI_WORLD_ID_PROOF_MODE: "dummy",
            },
        });

        expect(result.ok).toBe(false);
        expect(result.checks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: "SONARI_WORLD_ID_PROOF_MODE",
                    status: "fail",
                }),
            ]),
        );
    });

    it("rejects unsafe submit and network mismatches", async () => {
        const result = await validateMembershipIdentityLiveGate({
            env: {
                ...completeEnv(),
                RELAYER_ALLOW_SUBMIT: "false",
                RELAYER_GRPC_URL: "https://fullnode.mainnet.sui.io:443",
            },
        });

        expect(result.ok).toBe(false);
        expect(result.checks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: "RELAYER_ALLOW_SUBMIT",
                    status: "fail",
                }),
                expect.objectContaining({
                    name: "RELAYER_GRPC_URL",
                    status: "fail",
                }),
            ]),
        );
    });
});

function completeEnv(): Record<string, string> {
    return {
        STACK_NAME: "sonari-membership-identity-testnet",
        AWS_REGION: "us-east-1",
        AWS_PROFILE: "sonari-test",
        LAMBDA_CODE_S3_BUCKET: "lambda-bucket",
        LAMBDA_CODE_S3_KEY: "membership/commit/lambda.zip",
        TEE_ARTIFACT_S3_BUCKET: "tee-bucket",
        TEE_ARTIFACT_S3_KEY: "membership/commit/artifact.tar.gz",
        TEE_ARTIFACT_SHA256: "a".repeat(64),
        TEE_EIF_S3_BUCKET: "tee-bucket",
        TEE_EIF_S3_KEY: "membership/commit/membership-identity-tee.eif",
        TEE_EIF_SHA256: "b".repeat(64),
        NITRO_ENCLAVE_IMAGE_SHA384: "c".repeat(96),
        NITRO_ENCLAVE_PCR3: "d".repeat(96),
        SIGNING_SEED_CIPHERTEXT_S3_BUCKET: "secret-bucket",
        SIGNING_SEED_CIPHERTEXT_S3_KEY: "membership/signing-seed.ciphertext",
        SONARI_WORLD_ID_APP_ID: "app_staging_123",
        SONARI_WORLD_ID_API_BASE: "https://developer.world.org",
        SONARI_WORLD_ID_NULLIFIER_HASH: "1234567890",
        SONARI_WORLD_ID_MERKLE_ROOT: "0xabc",
        SONARI_WORLD_ID_PROOF: "0xproof",
        SONARI_WORLD_ID_VERIFICATION_LEVEL: "orb",
        SONARI_WORLD_ID_ACTION: "sonari_membership_register_v2",
        SONARI_WORLD_ID_SIGNAL_HASH: `0x${"11".repeat(32)}`,
        SONARI_IDENTITY_PACKAGE_ID: "0xabc",
        SONARI_IDENTITY_PAUSE_STATE_ID: "0x111",
        SONARI_IDENTITY_REGISTRY_ID: "0x222",
        SONARI_MEMBERSHIP_REGISTRY_ID: "0x333",
        SONARI_VERIFIER_REGISTRY_ID: "0x444",
        SONARI_MEMBERSHIP_PASS_ID: "0x555",
        RELAYER_NETWORK: "testnet",
        RELAYER_GRPC_URL: "https://fullnode.testnet.sui.io:443",
        RELAYER_SENDER_ADDRESS: "0xsender",
        RELAYER_MODE: "submit",
        RELAYER_ALLOW_SUBMIT: "true",
        RELAYER_SIGNER_SECRET_ARN: "arn:aws:secretsmanager:signer",
        SONARI_LIVE_EVIDENCE_PATH: "infra/aws/membership-identity-runner/evidence-template.md",
    };
}
