import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { describe, expect, it } from "vitest";
import {
    buildRelayerRequestPreview,
    createEd25519SuiSignerFromPrivateKey,
    dryRunRelayerSubmit,
    loadFixtureRelayerSubmitInput,
    submitRelayerPayload,
} from "./index.js";

const target = "0x123::accessor::create_disaster_event_from_signed_payload";
const registry = "0x456";
const verifierRegistry = "0x654";
const clock = "0x0000000000000000000000000000000000000000000000000000000000000006";
const senderAddress = "0x789";
const network = "testnet";
const grpcUrl = "https://fullnode.testnet.sui.io:443";

const fixtureInput = loadFixtureRelayerSubmitInput("usgs/finalized_minimal");
const fixturePayloadBytes = hexToBytes(
    "0x010100000000000000ab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd010000000c757337303030736f6e617269214d20372e31202d20536f6e61726920466978747572652045617274687175616b6515536f6e617269204669787475726520526567696f6e00f451c28c010000010303526e982479c985a009227facabf22c6d7633110fb1a15a743b453218f7f1890f02000000000000003a697066733a2f2f736f6e6172692f6578616d706c65732f757337303030736f6e6172692f65766964656e63655f6d616e69666573742e6a736f6e4c06a8a90a6c079fae70eb08b2a3cef95e14677186c3cc1cc3581896017cd18300b153c78c01000000489dc88c010000",
);
const fixtureSignatureBytes = hexToBytes(
    "0x5bd4504c0d7f235c44dbc32ae631ea2a9b3def90079b7806f5846e942b25e38757cb3b8b5c7b07d629a7051f325708602d333a3944cead1fa9b4747fe5c13c01",
);
const fixturePublicKeyBytes = hexToBytes(
    "0xea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c",
);
const fixtureVerifierConfigKey = 1;
const fixtureVerifierConfigVersion = 1;

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
            events: [
                {
                    eventType: "0x123::disaster_event::DisasterEventCreated",
                    json: {
                        disaster_event_id: "0xdisaster",
                    },
                },
            ],
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
                verifierConfigKey: fixtureVerifierConfigKey,
                verifierConfigVersion: fixtureVerifierConfigVersion,
                enclaveInstancePublicKey: fixtureInput.public_key,
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
                    verifierConfigKey: fixtureVerifierConfigKey,
                    verifierConfigVersion: fixtureVerifierConfigVersion,
                    enclaveInstancePublicKey: fixtureInput.public_key,
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
            { verifier_config_key: 0 },
            { verifier_config_key: 2 },
            { verifier_config_version: 0 },
            { enclave_instance_public_key: `0x${"33".repeat(32)}` },
            { enclave_instance_public_key: `0x${"22".repeat(31)}` },
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
    it("creates an Ed25519 signer from a Sui private key string", () => {
        const keypair = Ed25519Keypair.generate();
        const signer = createEd25519SuiSignerFromPrivateKey(keypair.getSecretKey());

        expect(signer.toSuiAddress()).toBe(keypair.toSuiAddress());
        expect(() =>
            createEd25519SuiSignerFromPrivateKey(Secp256k1Keypair.generate().getSecretKey()),
        ).toThrow("Only Ed25519 Sui private keys are supported for relayer submit");
    });

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
                network,
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
                network,
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
                network,
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
                network,
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
                network,
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
                network,
                grpcUrl,
                client: {
                    signAndExecuteTransaction: async () => successfulTransactionResponse(),
                },
                transaction: makeFakeTransaction(),
            }),
        ).resolves.toMatchObject({ ok: false, error_code: "RELAYER_SUBMIT_FAILED" });
    });

    it("fails closed for missing, invalid, or mismatched Sui network configuration", async () => {
        const validDryRunConfig = {
            target,
            registry,
            verifierRegistry,
            grpcUrl,
            senderAddress,
            client: {
                simulateTransaction: async () => successfulTransactionResponse(),
            },
            transaction: makeFakeTransaction(),
        };

        await expect(
            dryRunRelayerSubmit(fixtureInput, {
                ...validDryRunConfig,
                network: "" as "testnet",
            }),
        ).resolves.toMatchObject({
            ok: false,
            error_code: "RELAYER_SUBMIT_FAILED",
            message: "Unsupported Sui network: ",
        });

        await expect(
            dryRunRelayerSubmit(fixtureInput, {
                ...validDryRunConfig,
                network: "localnet" as "testnet",
            }),
        ).resolves.toMatchObject({
            ok: false,
            error_code: "RELAYER_SUBMIT_FAILED",
            message: "Unsupported Sui network: localnet",
        });

        await expect(
            dryRunRelayerSubmit(fixtureInput, {
                ...validDryRunConfig,
                network: "testnet",
                grpcUrl: "https://fullnode.mainnet.sui.io:443",
            }),
        ).resolves.toMatchObject({
            ok: false,
            error_code: "RELAYER_SUBMIT_FAILED",
            message:
                "RELAYER_GRPC_URL host fullnode.mainnet.sui.io does not match RELAYER_NETWORK=testnet",
        });

        await expect(
            dryRunRelayerSubmit(fixtureInput, {
                ...validDryRunConfig,
                network: "testnet",
            }),
        ).resolves.toMatchObject({ ok: true });
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
            network,
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

    it("submits with effects and events included and returns digest, effects, and object ID", async () => {
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
            network,
            grpcUrl,
            signer,
            client,
            transaction,
        });

        expect(result).toMatchObject({
            ok: true,
            value: {
                digest: "abc",
                objectId: "0xdisaster",
                effects,
            },
        });
        expect(calls).toEqual([
            {
                transaction,
                signer,
                include: { effects: true, events: true, objectTypes: true },
            },
        ]);
    });

    it("falls back to typed effects created objects when events do not contain the object ID", async () => {
        const signer = Ed25519Keypair.generate();

        await expect(
            submitRelayerPayload(fixtureInput, {
                target,
                registry,
                verifierRegistry,
                network,
                grpcUrl,
                signer,
                client: {
                    signAndExecuteTransaction: async () => ({
                        $kind: "Transaction" as const,
                        Transaction: {
                            digest: "abc",
                            status: { success: true as const, error: null },
                            effects: {
                                status: { success: true, error: null },
                                changedObjects: [
                                    {
                                        objectId: "0xfallback",
                                        outputState: "ObjectWrite",
                                        idOperation: "Created",
                                    },
                                ],
                            },
                            events: [],
                            objectTypes: {
                                "0xfallback": "0x123::disaster_event::DisasterEvent",
                            },
                        },
                    }),
                },
                transaction: makeFakeTransaction(),
            }),
        ).resolves.toMatchObject({
            ok: true,
            value: {
                objectId: "0xfallback",
            },
        });
    });

    it("fails closed when a successful submit response does not include an object ID", async () => {
        const signer = Ed25519Keypair.generate();

        await expect(
            submitRelayerPayload(fixtureInput, {
                target,
                registry,
                verifierRegistry,
                network,
                grpcUrl,
                signer,
                client: {
                    signAndExecuteTransaction: async () => ({
                        $kind: "Transaction" as const,
                        Transaction: {
                            digest: "abc",
                            status: { success: true as const, error: null },
                            effects: { status: { success: true, error: null } },
                            events: [],
                        },
                    }),
                },
                transaction: makeFakeTransaction(),
            }),
        ).resolves.toMatchObject({
            ok: false,
            error_code: "RELAYER_SUBMIT_FAILED",
            message: "Sui response did not include created DisasterEvent object ID",
        });
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
                    network,
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
