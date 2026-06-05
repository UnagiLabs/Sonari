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
// membershipPassId removed from tx builder: Move accessor no longer takes MembershipPass arg
const clockId = "0x6";
const network = "testnet";
const grpcUrl = "https://fullnode.testnet.sui.io:443";
const senderAddress = "0xsender";

describe("membership identity Sui submission", () => {
    it("builds update_identity_verification arguments (8 args, no membershipPassId) from signed TEE bytes", () => {
        const result = buildIdentityVerificationSuiRequest(verifiedResult(), baseConfig());

        // STEP 5: membershipPassId フィールドが削除され、arguments は 8 要素
        expect(result).toEqual({
            ok: true,
            value: {
                target: "0xabc::accessor::update_identity_verification",
                packageId,
                pauseStateId,
                identityRegistryId,
                membershipRegistryId,
                verifierRegistryId,
                clockId,
                // membershipPassId フィールドなし
                arguments: [
                    pauseStateId,
                    identityRegistryId,
                    membershipRegistryId,
                    verifierRegistryId,
                    clockId,
                    [1, 2, 3],
                    Array.from({ length: 64 }, () => 0x11),
                    Array.from({ length: 32 }, () => 0x22),
                ],
            },
        });
    });

    it("request does not contain membershipPassId field", () => {
        const result = buildIdentityVerificationSuiRequest(verifiedResult(), baseConfig());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // membershipPassId フィールドが存在しないこと
        expect(Object.hasOwn(result.value, "membershipPassId")).toBe(false);
    });

    it("arguments array is exactly 8 elements (no membership pass object)", () => {
        const result = buildIdentityVerificationSuiRequest(verifiedResult(), baseConfig());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.arguments).toHaveLength(8);
        // 新順序: [pauseState, identityRegistry, membershipRegistry, verifierRegistry, clock, payload, signature, publicKey]
        expect(result.value.arguments[0]).toBe(pauseStateId);
        expect(result.value.arguments[1]).toBe(identityRegistryId);
        expect(result.value.arguments[2]).toBe(membershipRegistryId);
        expect(result.value.arguments[3]).toBe(verifierRegistryId);
        expect(result.value.arguments[4]).toBe(clockId);
        expect(result.value.arguments[5]).toEqual([1, 2, 3]); // payload
        expect(result.value.arguments[6]).toEqual(Array.from({ length: 64 }, () => 0x11)); // signature
        expect(result.value.arguments[7]).toEqual(Array.from({ length: 32 }, () => 0x22)); // publicKey
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
        let signAndExecuteCalls = 0;
        const client = fakeClient({
            simulateTransaction: async () => successfulTransaction("dry-run-digest"),
            signAndExecuteTransaction: async () => {
                signAndExecuteCalls += 1;
                return successfulTransaction("unexpected-submit");
            },
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
        expect(signAndExecuteCalls).toBe(0);

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

    it("maps dry-run Move failures to MOVE_REJECTED without submit fallback", async () => {
        let signAndExecuteCalls = 0;
        const failedTransactionClient = fakeClient({
            simulateTransaction: async () => ({
                $kind: "FailedTransaction",
                FailedTransaction: {
                    status: { success: false, error: "Move abort: invalid signature" },
                    effects: {},
                },
            }),
            signAndExecuteTransaction: async () => {
                signAndExecuteCalls += 1;
                return successfulTransaction("unexpected-submit");
            },
        });

        await expect(
            dryRunIdentityVerificationSubmit(verifiedResult(), {
                ...baseConfig(),
                network,
                grpcUrl,
                senderAddress,
                transaction: fakeTransaction(new Uint8Array([1])),
                client: failedTransactionClient,
            }),
        ).resolves.toEqual({
            ok: false,
            error_code: "MOVE_REJECTED",
            message: "Move abort: invalid signature",
        });
        expect(signAndExecuteCalls).toBe(0);

        await expect(
            dryRunIdentityVerificationSubmit(verifiedResult(), {
                ...baseConfig(),
                network,
                grpcUrl,
                senderAddress,
                transaction: fakeTransaction(new Uint8Array([2])),
                client: fakeClient({
                    simulateTransaction: async () => ({
                        $kind: "Transaction",
                        Transaction: {
                            status: {
                                success: false,
                                error: { message: "Move transaction reported failure" },
                            },
                            effects: {},
                        },
                    }),
                }),
            }),
        ).resolves.toEqual({
            ok: false,
            error_code: "MOVE_REJECTED",
            message: "Move transaction reported failure",
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

        // STEP 5: submit 成功はdigest ベース判定。readback フィールドなし
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
                mode: "submit",
                digest: "submit-digest",
            },
        });

        // readback フィールドが存在しないこと
        const result = await submitIdentityVerificationPayload(verifiedResult(), {
            ...baseConfig(),
            network,
            grpcUrl,
            allowSubmit: true,
            signer,
            client,
            transaction: {},
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(Object.hasOwn(result.value, "readback")).toBe(false);
    });

    it("fails closed when configured sender address does not match the submit signer", async () => {
        const signer = createEd25519SuiSignerFromPrivateKey(
            "suiprivkey1qzhxm3kgv4atgnt2gwkeefddg8zngmje9tvm86ax0as33qs5tjxzktptcaf",
        );
        let signAndExecuteCalls = 0;
        const client = fakeClient({
            signAndExecuteTransaction: async () => {
                signAndExecuteCalls += 1;
                return successfulTransaction("submit-digest");
            },
        });

        await expect(
            submitIdentityVerificationPayload(verifiedResult(), {
                ...baseConfig(),
                network,
                grpcUrl,
                senderAddress: "0xsender",
                allowSubmit: true,
                signer,
                client,
                transaction: {},
            }),
        ).resolves.toEqual({
            ok: false,
            error_code: "RELAYER_SUBMIT_FAILED",
            message: "Signer address does not match RELAYER_SENDER_ADDRESS",
        });
        expect(signAndExecuteCalls).toBe(0);
    });

    it("submit succeeds with digest-based result (waitForTransaction only, no object read)", async () => {
        // STEP 5: getObject は不要。waitForTransaction + digest で成功を返す
        const signer = createEd25519SuiSignerFromPrivateKey(
            "suiprivkey1qzhxm3kgv4atgnt2gwkeefddg8zngmje9tvm86ax0as33qs5tjxzktptcaf",
        );
        let waitForTransactionCalled = false;
        const client = fakeClient({
            signAndExecuteTransaction: async () => successfulTransaction("submit-digest"),
            waitForTransaction: async () => {
                waitForTransactionCalled = true;
                return undefined;
            },
        });

        const result = await submitIdentityVerificationPayload(verifiedResult(), {
            ...baseConfig(),
            network,
            grpcUrl,
            allowSubmit: true,
            signer,
            client,
            transaction: {},
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.digest).toBe("submit-digest");
        // waitForTransaction は呼ばれる（finality 待ち）
        expect(waitForTransactionCalled).toBe(true);
    });

    it("waitForTransaction failure surfaces as RELAYER_SUBMIT_FAILED with digest", async () => {
        const signer = createEd25519SuiSignerFromPrivateKey(
            "suiprivkey1qzhxm3kgv4atgnt2gwkeefddg8zngmje9tvm86ax0as33qs5tjxzktptcaf",
        );
        const client = fakeClient({
            signAndExecuteTransaction: async () => successfulTransaction("submit-digest"),
            waitForTransaction: async () => {
                throw new Error("waitForTransaction timed out");
            },
        });

        const result = await submitIdentityVerificationPayload(verifiedResult(), {
            ...baseConfig(),
            network,
            grpcUrl,
            allowSubmit: true,
            signer,
            client,
            transaction: {},
        });

        expect(result).toEqual({
            ok: false,
            error_code: "RELAYER_SUBMIT_FAILED",
            message: "waitForTransaction timed out",
            digest: "submit-digest",
        });
    });
});

describe("STEP 7: dynamic membershipPassId from verified result.membership_id", () => {
    const dynamicMembershipId = `0x${"aa".repeat(32)}`; // 32 bytes = Sui object id

    it("buildIdentityVerificationSuiRequest uses membership_id from input for context (not tx args)", () => {
        const input = {
            ...verifiedResult(),
            membership_id: dynamicMembershipId,
        };
        // STEP 5: membership_id は tx args に含まれない（Move側はpayload_bcsで照合）
        const config = configWithoutMembershipPass();
        const result = buildIdentityVerificationSuiRequest(input, config);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // arguments は 8 要素、membership_id オブジェクトは含まれない
        expect(result.value.arguments).toHaveLength(8);
        // membershipPassId フィールド自体が存在しない
        expect(Object.hasOwn(result.value, "membershipPassId")).toBe(false);
    });

    it("different membership_id values do not affect tx arguments (payload bytes differ)", () => {
        const id1 = `0x${"11".repeat(32)}`;
        const id2 = `0x${"22".repeat(32)}`;
        const config = configWithoutMembershipPass();

        const result1 = buildIdentityVerificationSuiRequest(
            { ...verifiedResult(), membership_id: id1 },
            config,
        );
        const result2 = buildIdentityVerificationSuiRequest(
            { ...verifiedResult(), membership_id: id2 },
            config,
        );

        expect(result1.ok && result2.ok).toBe(true);
        if (!result1.ok || !result2.ok) return;
        // STEP 5: tx args に membership_id は含まれないので引数長は同じ 8
        expect(result1.value.arguments).toHaveLength(8);
        expect(result2.value.arguments).toHaveLength(8);
        // clock が arguments[4] であることを確認
        expect(result1.value.arguments[4]).toBe(clockId);
        expect(result2.value.arguments[4]).toBe(clockId);
    });

    it("SONARI_MEMBERSHIP_PASS_ID env is not required when membership_id is in input", () => {
        // config has no membershipPassId field at all - must still work
        const config = configWithoutMembershipPass();
        const input = { ...verifiedResult(), membership_id: `0x${"bb".repeat(32)}` };
        const result = buildIdentityVerificationSuiRequest(input, config);
        expect(result.ok).toBe(true);
    });
});

// Helper: config without membershipPassId (field removed from IdentityVerificationSubmitConfig)
function configWithoutMembershipPass(): IdentityVerificationSubmitConfig {
    return {
        packageId,
        pauseStateId,
        identityRegistryId,
        membershipRegistryId,
        verifierRegistryId,
        clockId,
    };
}

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
        membership_id: `0x${"55".repeat(32)}`, // still present in payload (Move side checks it)
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
        waitForTransaction: methods.waitForTransaction ?? (async () => undefined),
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
