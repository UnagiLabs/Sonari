import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { describe, expect, it } from "vitest";
import {
    buildRelayerRequestPreview,
    dryRunRelayerSubmit,
    loadFixtureRelayerSubmitInput,
    submitRelayerPayload,
} from "./index.js";

const target = "0x123::earthquake_oracle::submit_payload_v1";
const registry = "0x456";
const verifierRegistry = "0x654";
const clock = "0x0000000000000000000000000000000000000000000000000000000000000006";
const senderAddress = "0x789";
const grpcUrl = "https://fullnode.testnet.sui.io:443";

const fixtureInput = loadFixtureRelayerSubmitInput("usgs/finalized_minimal");
const fixturePayloadBytes = hexToBytes(
    "0x010100000000000000ab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd01030100000000f451c28c01000000b153c78c01000000b153c78c010000010306fc83f3519bc43798fb3e8a285445d3a2f267d79796d73cea1099e9de1333ad1d4705b33531e84cb4337b092a358fcce3f38de64c68474b141402f5265aeff83a697066733a2f2f736f6e6172692f6578616d706c65732f757337303030736f6e6172692f7261775f646174615f6d616e69666573742e6a736f6e526e982479c985a009227facabf22c6d7633110fb1a15a743b453218f7f1890f37697066733a2f2f736f6e6172692f6578616d706c65732f757337303030736f6e6172692f61666665637465645f63656c6c732e6a736f6ec3bb6d3a0ba176465f91024bf73aa89c1ba45aaa4f739a93288f2cbcafdb30bc07010101010302000000000000000100489dc88c010000",
);
const fixtureSignatureBytes = hexToBytes(
    "0x0f8ae2a3a87999e6ba05d15ce68b902e5b4ef565d9ea17dc5f3b80200e089fef0216a05b569ecc48ceafed04098924ee58ea24b3d557ff1410b209b756bb7807",
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
