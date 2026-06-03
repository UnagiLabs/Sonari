import { describe, expect, it } from "vitest";
import {
    buildIdentityVerificationSuiRequest,
    createEd25519SuiSignerFromPrivateKey,
    dryRunIdentityVerificationSubmit,
    type IdentityVerificationSubmitClient,
    type IdentityVerificationSubmitConfig,
    type IdentityVerificationSubmitTransaction,
    SuiEnclaveRegistrationAdapter,
    type SuiEnclaveRegistrationClient,
    type SuiEnclaveRegistrationConfig,
    type SuiEnclaveRegistrationEvent,
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

describe("SuiEnclaveRegistrationAdapter (case A: register=real submit)", () => {
    const IDENTITY_VERIFIER_CONFIG_KEY = 2;
    const IDENTITY_VERIFIER_FAMILY = 4;
    const IDENTITY_VERIFIER_VERSION = 1;

    const packageId = "0xpkg";
    const verifierRegistryId = "0xreg";

    function makeFakeRegistrationClient(opts: {
        succeed: boolean;
        events?: SuiEnclaveRegistrationEvent[];
    }): SuiEnclaveRegistrationClient {
        return {
            signAndExecuteTransaction: async () => {
                if (!opts.succeed) {
                    return {
                        $kind: "FailedTransaction" as const,
                        FailedTransaction: {
                            status: { success: false, error: "Move tx failed" },
                            effects: {},
                            events: [],
                        },
                    };
                }
                return {
                    $kind: "Transaction" as const,
                    Transaction: {
                        status: { success: true as const, error: null },
                        effects: { status: { success: true } },
                        events: opts.events ?? [],
                    },
                };
            },
        };
    }

    function makeRegistrationEvent(overrides?: {
        verifier_family?: number;
        verifier_version?: number;
        config_version?: number;
        public_key?: number[];
    }): SuiEnclaveRegistrationEvent {
        return {
            type: "0xpkg::metadata_verifier::EnclaveInstanceRegistered",
            json: {
                verifier_family: overrides?.verifier_family ?? IDENTITY_VERIFIER_FAMILY,
                verifier_version: overrides?.verifier_version ?? IDENTITY_VERIFIER_VERSION,
                config_version: overrides?.config_version ?? 1,
                public_key: overrides?.public_key ?? Array.from({ length: 32 }, () => 0xab),
            },
        };
    }

    function fakeSigner(): import("@mysten/sui/cryptography").Signer {
        return createEd25519SuiSignerFromPrivateKey(
            "suiprivkey1qzhxm3kgv4atgnt2gwkeefddg8zngmje9tvm86ax0as33qs5tjxzktptcaf",
        );
    }

    function baseRegistrationConfig(
        overrides?: Partial<SuiEnclaveRegistrationConfig>,
    ): SuiEnclaveRegistrationConfig {
        return {
            target: `${packageId}::metadata_verifier::register_enclave_instance_for_config`,
            verifierRegistry: verifierRegistryId,
            allowSubmit: true,
            instanceTtlMs: 60_000,
            now: () => 1_000_000,
            signer: fakeSigner(),
            ...overrides,
        };
    }

    it("register target contains register_enclave_instance_for_config and configKey=2 is propagated", async () => {
        // The target in config must encode register_enclave_instance_for_config
        expect(
            baseRegistrationConfig().target.endsWith(
                "::metadata_verifier::register_enclave_instance_for_config",
            ),
        ).toBe(true);

        const client = makeFakeRegistrationClient({
            succeed: true,
            events: [makeRegistrationEvent()],
        });

        const adapter = new SuiEnclaveRegistrationAdapter({
            ...baseRegistrationConfig(),
            client,
        });

        // Call register and verify it returns correct config key
        const metadata = await adapter.register({
            jobId: "job-1",
            attestationDocumentHex: `0x${"aa".repeat(100)}`,
            publicKey: `0x${"ab".repeat(32)}`,
        });

        expect(metadata.verifier_config_key).toBe(IDENTITY_VERIFIER_CONFIG_KEY);
        expect(metadata.verifier_config_version).toBeGreaterThan(0);
        expect(metadata.enclave_instance_public_key).toBe(`0x${"ab".repeat(32)}`);
    });

    it("register calls signAndExecuteTransaction (real submit, not dry-run)", async () => {
        let signAndExecuteCalled = false;
        const client: SuiEnclaveRegistrationClient = {
            signAndExecuteTransaction: async () => {
                signAndExecuteCalled = true;
                return {
                    $kind: "Transaction" as const,
                    Transaction: {
                        status: { success: true as const, error: null },
                        effects: { status: { success: true } },
                        events: [makeRegistrationEvent()],
                    },
                };
            },
        };

        const adapter = new SuiEnclaveRegistrationAdapter({
            ...baseRegistrationConfig(),
            client,
        });

        await adapter.register({
            jobId: "job-2",
            attestationDocumentHex: `0x${"cc".repeat(50)}`,
            publicKey: `0x${"ab".repeat(32)}`,
        });

        // Case A: register is always real submit (signAndExecuteTransaction)
        expect(signAndExecuteCalled).toBe(true);
    });

    it("register parses EnclaveInstanceRegistered event with family=4, version=1, configKey=2", async () => {
        const client = makeFakeRegistrationClient({
            succeed: true,
            events: [
                makeRegistrationEvent({
                    verifier_family: IDENTITY_VERIFIER_FAMILY,
                    verifier_version: IDENTITY_VERIFIER_VERSION,
                    config_version: 3,
                    public_key: Array.from({ length: 32 }, () => 0xab),
                }),
            ],
        });

        const adapter = new SuiEnclaveRegistrationAdapter({
            ...baseRegistrationConfig(),
            client,
        });

        const metadata = await adapter.register({
            jobId: "job-3",
            attestationDocumentHex: `0x${"dd".repeat(80)}`,
            publicKey: `0x${"ab".repeat(32)}`,
        });

        expect(metadata).toEqual({
            verifier_config_key: IDENTITY_VERIFIER_CONFIG_KEY,
            verifier_config_version: 3,
            enclave_instance_public_key: `0x${"ab".repeat(32)}`,
        });
    });

    it("register rejects wrong family or version in EnclaveInstanceRegistered event", async () => {
        const wrongFamilyClient = makeFakeRegistrationClient({
            succeed: true,
            events: [makeRegistrationEvent({ verifier_family: 3 })], // earthquake family
        });

        const adapter = new SuiEnclaveRegistrationAdapter({
            ...baseRegistrationConfig(),
            client: wrongFamilyClient,
        });

        await expect(
            adapter.register({
                jobId: "job-4",
                attestationDocumentHex: `0x${"ee".repeat(60)}`,
                publicKey: `0x${"ab".repeat(32)}`,
            }),
        ).rejects.toThrow();
    });

    it("register fails when public key in event does not match attestation", async () => {
        const differentKey = Array.from({ length: 32 }, () => 0xcd); // different from 0xab
        const client = makeFakeRegistrationClient({
            succeed: true,
            events: [makeRegistrationEvent({ public_key: differentKey })],
        });

        const adapter = new SuiEnclaveRegistrationAdapter({
            ...baseRegistrationConfig(),
            client,
        });

        await expect(
            adapter.register({
                jobId: "job-5",
                attestationDocumentHex: `0x${"ff".repeat(40)}`,
                publicKey: `0x${"ab".repeat(32)}`, // different from event
            }),
        ).rejects.toThrow("registered enclave public key does not match attestation");
    });

    it("register fails when allowSubmit is false (case A requires real submit)", async () => {
        const adapter = new SuiEnclaveRegistrationAdapter({
            ...baseRegistrationConfig(),
            allowSubmit: false,
        });

        await expect(
            adapter.register({
                jobId: "job-6",
                attestationDocumentHex: `0x${"aa".repeat(50)}`,
                publicKey: `0x${"ab".repeat(32)}`,
            }),
        ).rejects.toThrow();
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
