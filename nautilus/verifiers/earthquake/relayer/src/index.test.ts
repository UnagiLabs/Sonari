import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { describe, expect, it } from "vitest";
import {
    buildRelayerRequestPreview,
    dryRunRelayerSubmit,
    loadFixtureRelayerSubmitInput,
    submitRelayerPayload,
} from "./index.js";

const target = "0x123::earthquake_oracle::submit_payload";
const registry = "0x456";
const verifierRegistry = "0x654";
const clock = "0x0000000000000000000000000000000000000000000000000000000000000006";
const senderAddress = "0x789";
const grpcUrl = "https://fullnode.testnet.sui.io:443";

const fixtureInput = loadFixtureRelayerSubmitInput("usgs/finalized_minimal");
const fixturePayloadBytes = hexToBytes(
    "0x010100000000000000ab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd0103010000000c757337303030736f6e617269214d20372e31202d20536f6e61726920466978747572652045617274687175616b6515536f6e617269204669787475726520526567696f6e00f451c28c010000c60200000000000000b153c78c01000000b153c78c010000010306fc83f3519bc43798fb3e8a285445d3a2f267d79796d73cea1099e9de1333adecd638ae8aea66d2a8ee5b486c39dc8e71f9d342697549e66381397909a7b0a93a697066733a2f2f736f6e6172692f6578616d706c65732f757337303030736f6e6172692f7261775f646174615f6d616e69666573742e6a736f6e526e982479c985a009227facabf22c6d7633110fb1a15a743b453218f7f1890f37697066733a2f2f736f6e6172692f6578616d706c65732f757337303030736f6e6172692f61666665637465645f63656c6c732e6a736f6ec3bb6d3a0ba176465f91024bf73aa89c1ba45aaa4f739a93288f2cbcafdb30bc0200000000000000070101010100489dc88c010000",
);
const fixtureSignatureBytes = hexToBytes(
    "0x16cc2bce20f532dc9396dc62903ebc65abccb97221e72a75415cf6fc707fd0a285a761144db877f9ad1bc276aaeaec24f164583239dce269b766fe0c4d2a7708",
);
const fixturePublicKeyBytes = hexToBytes(
    "0xea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c",
);

function hexToBytes(hex: string): number[] {
    const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
    return Array.from(Buffer.from(normalized, "hex"));
}

function makeFakeTransaction(bytes = new Uint8Array([1, 2, 3])) {
    return {
        build: async () => bytes,
    };
}

function makeThrowingTransaction(error = new Error("build failed")) {
    return {
        build: async () => {
            throw error;
        },
    };
}

function successfulTransactionResponse(effects = { status: { success: true, error: null } }) {
    return {
        $kind: "Transaction" as const,
        Transaction: {
            digest: "abc",
            status: { success: true as const, error: null },
            effects,
        },
    };
}

function failedTransactionResponse(effects = { status: { success: false, error: null } }) {
    return {
        $kind: "FailedTransaction" as const,
        FailedTransaction: {
            digest: "abc",
            status: { success: false as const, error: { message: "Move abort" } },
            effects,
        },
    };
}

describe("relayer request preview", () => {
    it("converts the finalized fixture into deterministic Move entry arguments", () => {
        const result = buildRelayerRequestPreview(fixtureInput, {
            target,
            registry,
            verifierRegistry,
        });

        expect(result).toEqual({
            ok: true,
            value: {
                target,
                registry,
                verifierRegistry,
                clock,
                arguments: [
                    registry,
                    verifierRegistry,
                    clock,
                    fixturePayloadBytes,
                    fixtureSignatureBytes,
                    fixturePublicKeyBytes,
                ],
                submitRequest: {
                    target,
                    registry,
                    verifierRegistry,
                    clock,
                    arguments: [
                        registry,
                        verifierRegistry,
                        clock,
                        fixturePayloadBytes,
                        fixtureSignatureBytes,
                        fixturePublicKeyBytes,
                    ],
                },
            },
        });
    });

    it("rejects pending, rejected, and malformed input as relayer submit failures", () => {
        for (const input of [
            { ...fixtureInput, status: "pending_mmi" },
            { ...fixtureInput, status: "rejected" },
            null,
            [],
        ]) {
            expect(
                buildRelayerRequestPreview(input, { target, registry, verifierRegistry }),
            ).toMatchObject({
                ok: false,
                error_code: "RELAYER_SUBMIT_FAILED",
            });
        }
    });

    it("rejects malformed hex and signature encodings", () => {
        for (const patch of [
            { payload_bcs_hex: "0xzz" },
            { payload_bcs_hex: "0x0" },
            { signature: "" },
            { public_key: "" },
            { signature: `0x${"11".repeat(63)}` },
            { public_key: `0x${"22".repeat(33)}` },
            { signature: "AQID+/==" },
            { signature: "AFakeSuiSerializedSignatureValue==" },
        ]) {
            expect(
                buildRelayerRequestPreview(
                    { ...fixtureInput, ...patch },
                    { target, registry, verifierRegistry },
                ),
            ).toMatchObject({
                ok: false,
                error_code: "RELAYER_SUBMIT_FAILED",
            });
        }
    });

    it("accepts hex fields with or without a 0x prefix", () => {
        const withoutPrefixes = {
            ...fixtureInput,
            payload_bcs_hex: fixtureInput.payload_bcs_hex.slice(2),
            signature: fixtureInput.signature.slice(2),
            public_key: fixtureInput.public_key.slice(2),
        };

        expect(
            buildRelayerRequestPreview(withoutPrefixes, { target, registry, verifierRegistry }),
        ).toEqual(buildRelayerRequestPreview(fixtureInput, { target, registry, verifierRegistry }));
    });

    it("does not mutate input and returns identical output for retry-safe previews", () => {
        const input = structuredClone(fixtureInput);
        const before = structuredClone(input);

        const first = buildRelayerRequestPreview(input, { target, registry, verifierRegistry });
        const second = buildRelayerRequestPreview(input, { target, registry, verifierRegistry });

        expect(input).toEqual(before);
        expect(second).toEqual(first);
    });
});

describe("relayer submit execution", () => {
    it("maps dry-run and submit transaction failures to MOVE_REJECTED", async () => {
        const signer = Ed25519Keypair.generate();
        const client = {
            simulateTransaction: async () => failedTransactionResponse(),
            signAndExecuteTransaction: async () => failedTransactionResponse(),
        };

        await expect(
            dryRunRelayerSubmit(fixtureInput, {
                target,
                registry,
                verifierRegistry,
                grpcUrl,
                senderAddress,
                client,
                transaction: makeFakeTransaction(),
            }),
        ).resolves.toMatchObject({ ok: false, error_code: "MOVE_REJECTED" });

        await expect(
            submitRelayerPayload(fixtureInput, {
                target,
                registry,
                verifierRegistry,
                grpcUrl,
                signer,
                client,
                transaction: makeFakeTransaction(),
            }),
        ).resolves.toMatchObject({ ok: false, error_code: "MOVE_REJECTED" });
    });

    it("normalizes config, build, gRPC, and network failures to RELAYER_SUBMIT_FAILED", async () => {
        await expect(
            dryRunRelayerSubmit(fixtureInput, {
                target,
                registry,
                verifierRegistry,
                grpcUrl,
                senderAddress: "",
                client: {
                    simulateTransaction: async () => successfulTransactionResponse(),
                },
                transaction: makeFakeTransaction(),
            }),
        ).resolves.toMatchObject({ ok: false, error_code: "RELAYER_SUBMIT_FAILED" });

        await expect(
            dryRunRelayerSubmit(fixtureInput, {
                target,
                registry,
                verifierRegistry,
                grpcUrl,
                senderAddress,
                client: {
                    simulateTransaction: async () => successfulTransactionResponse(),
                },
                transaction: makeThrowingTransaction(),
            }),
        ).resolves.toMatchObject({ ok: false, error_code: "RELAYER_SUBMIT_FAILED" });

        await expect(
            dryRunRelayerSubmit(fixtureInput, {
                target,
                registry,
                verifierRegistry,
                grpcUrl,
                senderAddress,
                client: {
                    simulateTransaction: async () => {
                        throw new Error("network down");
                    },
                },
                transaction: makeFakeTransaction(),
            }),
        ).resolves.toMatchObject({ ok: false, error_code: "RELAYER_SUBMIT_FAILED" });

        await expect(
            submitRelayerPayload(fixtureInput, {
                target,
                registry,
                verifierRegistry,
                grpcUrl,
                client: {
                    signAndExecuteTransaction: async () => successfulTransactionResponse(),
                },
                transaction: makeFakeTransaction(),
            }),
        ).resolves.toMatchObject({ ok: false, error_code: "RELAYER_SUBMIT_FAILED" });
    });

    it("dry-runs with simulateTransaction and built transaction bytes", async () => {
        const transactionBytes = new Uint8Array([4, 5, 6]);
        const calls: unknown[] = [];
        const client = {
            simulateTransaction: async (input: unknown) => {
                calls.push(input);
                return successfulTransactionResponse();
            },
        };

        const result = await dryRunRelayerSubmit(fixtureInput, {
            target,
            registry,
            verifierRegistry,
            grpcUrl,
            senderAddress,
            client,
            transaction: makeFakeTransaction(transactionBytes),
        });

        expect(result).toMatchObject({
            ok: true,
            value: {
                transactionBytes: [4, 5, 6],
            },
        });
        expect(calls).toEqual([
            {
                transaction: transactionBytes,
                include: { effects: true },
            },
        ]);
        expect(client).not.toHaveProperty(["dryRun", "TransactionBlock"].join(""));
    });

    it("submits with effects included and returns the current API digest and effects", async () => {
        const effects = { status: { success: true, error: null }, transactionDigest: "abc" };
        const calls: unknown[] = [];
        const client = {
            signAndExecuteTransaction: async (input: unknown) => {
                calls.push(input);
                return successfulTransactionResponse(effects);
            },
        };
        const signer = Ed25519Keypair.generate();
        const transaction = makeFakeTransaction();

        const result = await submitRelayerPayload(fixtureInput, {
            target,
            registry,
            verifierRegistry,
            grpcUrl,
            signer,
            client,
            transaction,
        });

        expect(result).toMatchObject({
            ok: true,
            value: {
                digest: "abc",
                effects,
            },
        });
        expect(calls).toEqual([
            {
                transaction,
                signer,
                include: { effects: true },
            },
        ]);
    });

    it("normalizes missing effects and unknown SDK response shapes to RELAYER_SUBMIT_FAILED", async () => {
        for (const response of [
            {
                $kind: "Transaction",
                Transaction: {
                    digest: "abc",
                    status: { success: true, error: null },
                },
            },
            {
                $kind: "Other",
                Other: {},
            },
        ]) {
            await expect(
                dryRunRelayerSubmit(fixtureInput, {
                    target,
                    registry,
                    verifierRegistry,
                    grpcUrl,
                    senderAddress,
                    client: {
                        simulateTransaction: async () => response,
                    },
                    transaction: makeFakeTransaction(),
                }),
            ).resolves.toMatchObject({ ok: false, error_code: "RELAYER_SUBMIT_FAILED" });
        }
    });
});
