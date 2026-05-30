import { describe, expect, it } from "vitest";
import {
    buildIdentityVerificationSuiRequest,
    createEd25519SuiSignerFromPrivateKey,
    dryRunIdentityVerificationSubmit,
    type IdentityVerificationSubmitClient,
    type IdentityVerificationSubmitConfig,
    type IdentityVerificationSubmitTransaction,
    submitIdentityVerificationPayload,
} from "../src/sui_submission.js";

const packageId = "0xabc";
const pauseStateId = "0x111";
const identityRegistryId = "0x222";
const membershipRegistryId = "0x333";
const verifierRegistryId = "0x444";
const membershipPassId = "0x555";
const clockId = "0x6";
const network = "testnet";
const grpcUrl = "https://fullnode.testnet.sui.io:443";
const senderAddress = "0xsender";

describe("membership identity Sui submission", () => {
    it("builds update_identity_verification arguments from signed TEE bytes only", () => {
        const result = buildIdentityVerificationSuiRequest(verifiedResult(), baseConfig());

        expect(result).toEqual({
            ok: true,
            value: {
                target: "0xabc::accessor::update_identity_verification",
                packageId,
                pauseStateId,
                identityRegistryId,
                membershipRegistryId,
                verifierRegistryId,
                membershipPassId,
                clockId,
                arguments: [
                    pauseStateId,
                    identityRegistryId,
                    membershipRegistryId,
                    verifierRegistryId,
                    membershipPassId,
                    clockId,
                    [1, 2, 3],
                    Array.from({ length: 64 }, () => 0x11),
                    Array.from({ length: 32 }, () => 0x22),
                ],
            },
        });
    });

    it("rejects status-only, malformed hex, and malformed signature material", () => {
        for (const input of [
            { status: "pending_source", error_code: "WAIT" },
            { status: "rejected", error_code: "NOPE" },
            { ...verifiedResult(), payload_bcs_hex: "0x0" },
            { ...verifiedResult(), payload_bcs_hex: "0xzz" },
            { ...verifiedResult(), signature: `0x${"11".repeat(63)}` },
            { ...verifiedResult(), public_key: `0x${"22".repeat(31)}` },
        ]) {
            expect(buildIdentityVerificationSuiRequest(input, baseConfig())).toMatchObject({
                ok: false,
                error_code: "RELAYER_SUBMIT_FAILED",
            });
        }
    });

    it("dry-runs without signer material and fails closed when dry-run config is missing", async () => {
        const transaction = fakeTransaction(new Uint8Array([9, 8, 7]));
        const client = fakeClient({
            simulateTransaction: async () => successfulTransaction("dry-run-digest"),
        });

        await expect(
            dryRunIdentityVerificationSubmit(verifiedResult(), {
                ...baseConfig(),
                network,
                grpcUrl,
                senderAddress,
                transaction,
                client,
            }),
        ).resolves.toMatchObject({
            ok: true,
            value: {
                transactionBytes: [9, 8, 7],
                request: {
                    target: "0xabc::accessor::update_identity_verification",
                },
            },
        });

        await expect(
            dryRunIdentityVerificationSubmit(verifiedResult(), {
                ...baseConfig(),
                network,
                grpcUrl,
            }),
        ).resolves.toMatchObject({
            ok: false,
            error_code: "RELAYER_SUBMIT_FAILED",
            message: "dry_run requires network, grpcUrl, and senderAddress",
        });
    });

    it("submit requires explicit allow flag and signer before executing", async () => {
        const client = fakeClient({
            signAndExecuteTransaction: async () => successfulTransaction("submit-digest"),
        });
        const signer = createEd25519SuiSignerFromPrivateKey(
            "suiprivkey1qzhxm3kgv4atgnt2gwkeefddg8zngmje9tvm86ax0as33qs5tjxzktptcaf",
        );

        await expect(
            submitIdentityVerificationPayload(verifiedResult(), {
                ...baseConfig(),
                network,
                grpcUrl,
                allowSubmit: false,
                signer,
                client,
            }),
        ).resolves.toMatchObject({
            ok: false,
            message: "submit requires RELAYER_ALLOW_SUBMIT=true",
        });

        await expect(
            submitIdentityVerificationPayload(verifiedResult(), {
                ...baseConfig(),
                network,
                grpcUrl,
                allowSubmit: true,
                client,
            }),
        ).resolves.toMatchObject({
            ok: false,
            message: "submit requires signer material",
        });

        await expect(
            submitIdentityVerificationPayload(verifiedResult(), {
                ...baseConfig(),
                network,
                grpcUrl,
                allowSubmit: true,
                signer,
                client,
                transaction: {},
            }),
        ).resolves.toMatchObject({
            ok: true,
            value: {
                digest: "submit-digest",
            },
        });
    });
});

function baseConfig(): IdentityVerificationSubmitConfig {
    return {
        packageId,
        pauseStateId,
        identityRegistryId,
        membershipRegistryId,
        verifierRegistryId,
        membershipPassId,
        clockId,
    };
}

function verifiedResult(): Record<string, unknown> {
    return {
        status: "verified",
        payload_bcs_hex: "0x010203",
        signature: `0x${"11".repeat(64)}`,
        public_key: `0x${"22".repeat(32)}`,
        intent: "ignored by relayer",
        membership_id: "ignored by relayer",
    };
}

function fakeTransaction(bytes: Uint8Array): IdentityVerificationSubmitTransaction {
    return {
        build: async () => bytes,
    };
}

function fakeClient(
    methods: Partial<IdentityVerificationSubmitClient>,
): IdentityVerificationSubmitClient {
    return {
        simulateTransaction:
            methods.simulateTransaction ?? (async () => successfulTransaction("dry")),
        signAndExecuteTransaction:
            methods.signAndExecuteTransaction ?? (async () => successfulTransaction("submit")),
    };
}

function successfulTransaction(digest: string) {
    return {
        $kind: "Transaction" as const,
        Transaction: {
            digest,
            status: { success: true as const, error: null },
            effects: { status: { success: true } },
        },
    };
}
