import { describe, expect, it } from "vitest";
import {
    acquireSharedRunnerLease,
    buildSharedRunnerLeaseOwner,
    createSuiEnclaveRegistrationTransaction,
    dispatchRunnerCommand,
    type EnclaveRegistrationEvent,
    type EnclaveRegistrationExecutionResponse,
    type EnclaveVerificationMetadata,
    findReadyRunnerInstance,
    isHexBytes,
    normalizeHex,
    parseExpectedVerifierKind,
    parseHexByteVector,
    parseVerifierKind,
    pollRunnerCommand,
    readEnclaveAttestation,
    readEnclaveRegistrationMetadata,
    readRunnerResultText,
    releaseSharedRunnerLease,
    requireRegistrationMetadata,
    type SharedRunnerLeaseStore,
    setRunnerDesiredCapacity,
    withVerifierKind,
} from "./index.js";

describe("verifier kind contract", () => {
    it("accepts earthquake", () => {
        expect(parseVerifierKind("earthquake")).toBe("earthquake");
    });

    it("accepts membership_identity", () => {
        expect(parseVerifierKind("membership_identity")).toBe("membership_identity");
    });

    it("rejects unknown values fail-closed", () => {
        expect(() => parseVerifierKind("membership")).toThrow(/verifier_kind/);
        expect(() => parseVerifierKind(undefined)).toThrow(/verifier_kind/);
        expect(() => parseVerifierKind({ verifier_kind: "earthquake" })).toThrow(/verifier_kind/);
    });

    it("fails closed when a known kind reaches the wrong workflow boundary", () => {
        expect(parseExpectedVerifierKind("earthquake", "earthquake")).toBe("earthquake");
        expect(() => parseExpectedVerifierKind("membership_identity", "earthquake")).toThrow(
            /verifier_kind/,
        );
    });
});

describe("common runner dispatcher", () => {
    it("orchestrates EC2 capacity, SSM command lifecycle, and S3 result reads", async () => {
        const autoscaling = new RecordingAutoScalingClient();
        const ssm = new RecordingSsmClient();

        await setRunnerDesiredCapacity(autoscaling, {
            autoScalingGroupName: "runner-asg",
            desiredCapacity: 1,
        });
        await expect(
            findReadyRunnerInstance(new RecordingEc2Client(), ssm, {
                autoScalingGroupName: "runner-asg",
            }),
        ).resolves.toBe("i-ready");
        await expect(
            dispatchRunnerCommand(ssm, {
                workflowId: "job-1",
                instanceId: "i-ready",
                dispatchTimestampMs: 1_800_000_000_000,
                buildShellCommand: (resultS3Key) => `run verifier > ${resultS3Key}`,
            }),
        ).resolves.toEqual({
            commandId: "cmd-1",
            resultS3Key: "results/job-1/1800000000000.json",
            commandPollCount: 0,
        });
        await expect(
            pollRunnerCommand(ssm, {
                instanceId: "i-ready",
                commandId: "cmd-1",
                commandPollCount: 0,
            }),
        ).resolves.toEqual({ commandStatus: "SUCCEEDED", commandPollCount: 0 });
        await expect(
            readRunnerResultText(new RecordingS3Client(), {
                bucket: "runner-results",
                key: "results/job-1/1800000000000.json",
            }),
        ).resolves.toBe('{"status":"ok"}');

        expect(autoscaling.capacities).toEqual([1]);
        expect(ssm.commands).toEqual([
            {
                instanceId: "i-ready",
                shellCommand: "run verifier > results/job-1/1800000000000.json",
            },
        ]);
    });

    it("retains verifier kind on dispatcher outputs only when the boundary provided one", () => {
        expect(withVerifierKind("earthquake", { capacity: 1 })).toEqual({
            verifier_kind: "earthquake",
            capacity: 1,
        });
        expect(withVerifierKind(undefined, { capacity: 1 })).toEqual({ capacity: 1 });
    });

    it("serializes shared runner leases across verifier kinds", async () => {
        const store = new InMemorySharedRunnerLeaseStore();
        const earthquakeOwner = buildSharedRunnerLeaseOwner({
            verifierKind: "earthquake",
            workflowId: "us7000sonari",
            attempt: 1,
        });
        const membershipOwner = buildSharedRunnerLeaseOwner({
            verifierKind: "membership_identity",
            workflowId: "membership-job-1",
            attempt: 1,
        });

        await acquireSharedRunnerLease(store, { owner: earthquakeOwner, nowMs: 1_800_000_000_000 });
        await expect(
            acquireSharedRunnerLease(store, { owner: membershipOwner, nowMs: 1_800_000_001_000 }),
        ).rejects.toThrow(/already leased/);
        await expect(releaseSharedRunnerLease(store, membershipOwner)).resolves.toBe(false);
        await expect(releaseSharedRunnerLease(store, earthquakeOwner)).resolves.toBe(true);
        await expect(
            acquireSharedRunnerLease(store, { owner: membershipOwner, nowMs: 1_800_000_002_000 }),
        ).resolves.toBeUndefined();
    });
});

// --- hex helpers ---

describe("normalizeHex", () => {
    it("strips 0x prefix and lowercases", () => {
        expect(normalizeHex("0xDEADBEEF")).toBe("deadbeef");
    });

    it("returns plain hex unchanged (lowercased)", () => {
        expect(normalizeHex("DEADBEEF")).toBe("deadbeef");
    });
});

describe("isHexBytes", () => {
    it("accepts 0x-prefixed even-length hex string", () => {
        expect(isHexBytes("0xdeadbeef")).toBe(true);
    });

    it("accepts plain even-length hex string", () => {
        expect(isHexBytes("deadbeef")).toBe(true);
    });

    it("rejects odd-length hex", () => {
        expect(isHexBytes("0xabc")).toBe(false);
    });

    it("rejects non-hex characters", () => {
        expect(isHexBytes("0xGG")).toBe(false);
    });

    it("accepts with expectedBytes constraint", () => {
        const hex32 = `0x${"ab".repeat(32)}`;
        expect(isHexBytes(hex32, 32)).toBe(true);
    });

    it("rejects when expectedBytes does not match", () => {
        const hex16 = `0x${"ab".repeat(16)}`;
        expect(isHexBytes(hex16, 32)).toBe(false);
    });
});

describe("parseHexByteVector", () => {
    it("converts hex string to byte array", () => {
        expect(parseHexByteVector("0xdeadbeef")).toEqual([0xde, 0xad, 0xbe, 0xef]);
    });

    it("works without 0x prefix", () => {
        expect(parseHexByteVector("deadbeef")).toEqual([0xde, 0xad, 0xbe, 0xef]);
    });
});

// --- enclave attestation ---

describe("readEnclaveAttestation", () => {
    const validPublicKey = `0x${"ab".repeat(32)}`;
    const validAttestationDoc = `0x${"cd".repeat(100)}`;

    it("parses valid attestation JSON", () => {
        const result = readEnclaveAttestation({
            attestation_document_hex: validAttestationDoc,
            public_key: validPublicKey,
        });
        expect(result.attestation_document_hex).toBe(validAttestationDoc);
        expect(result.public_key).toBe(validPublicKey);
    });

    it("throws on missing attestation_document_hex", () => {
        expect(() =>
            readEnclaveAttestation({
                public_key: validPublicKey,
            }),
        ).toThrow(/malformed/);
    });

    it("throws on malformed public_key (wrong length)", () => {
        expect(() =>
            readEnclaveAttestation({
                attestation_document_hex: validAttestationDoc,
                public_key: "0xdeadbeef",
            }),
        ).toThrow(/malformed/);
    });

    it("throws on non-object input", () => {
        expect(() => readEnclaveAttestation("not-an-object")).toThrow(/malformed/);
    });
});

// --- readEnclaveRegistrationMetadata ---

const VALID_PUBLIC_KEY_HEX = `0x${"aa".repeat(32)}`;

function makeRegisteredEvent(overrides: Record<string, unknown> = {}): EnclaveRegistrationEvent {
    return {
        eventType: "0x1234::metadata_verifier::EnclaveInstanceRegistered",
        json: {
            verifier_family: 3,
            verifier_version: 1,
            config_version: 5,
            public_key: VALID_PUBLIC_KEY_HEX,
            ...overrides,
        },
    };
}

describe("readEnclaveRegistrationMetadata", () => {
    it("returns metadata for earthquake (family=3, version=1, configKey=1)", () => {
        const events = [makeRegisteredEvent()];
        const result = readEnclaveRegistrationMetadata(events, {
            expectedFamily: 3,
            expectedVersion: 1,
            configKey: 1,
        });
        expect(result).toEqual<EnclaveVerificationMetadata>({
            verifier_config_key: 1,
            verifier_config_version: 5,
            enclave_instance_public_key: VALID_PUBLIC_KEY_HEX,
        });
    });

    it("returns metadata for identity-like verifier (family=2, version=1, configKey=2)", () => {
        const events = [
            {
                eventType: "0x5678::metadata_verifier::EnclaveInstanceRegistered",
                json: {
                    verifier_family: 2,
                    verifier_version: 1,
                    config_version: 3,
                    public_key: VALID_PUBLIC_KEY_HEX,
                },
            },
        ];
        const result = readEnclaveRegistrationMetadata(events, {
            expectedFamily: 2,
            expectedVersion: 1,
            configKey: 2,
        });
        expect(result).toEqual<EnclaveVerificationMetadata>({
            verifier_config_key: 2,
            verifier_config_version: 3,
            enclave_instance_public_key: VALID_PUBLIC_KEY_HEX,
        });
    });

    it("throws when family does not match", () => {
        const events = [makeRegisteredEvent({ verifier_family: 9 })];
        expect(() =>
            readEnclaveRegistrationMetadata(events, {
                expectedFamily: 3,
                expectedVersion: 1,
                configKey: 1,
            }),
        ).toThrow(/did not match/);
    });

    it("throws when version does not match", () => {
        const events = [makeRegisteredEvent({ verifier_version: 99 })];
        expect(() =>
            readEnclaveRegistrationMetadata(events, {
                expectedFamily: 3,
                expectedVersion: 1,
                configKey: 1,
            }),
        ).toThrow(/did not match/);
    });

    it("throws when no EnclaveInstanceRegistered event is present", () => {
        expect(() =>
            readEnclaveRegistrationMetadata([], {
                expectedFamily: 3,
                expectedVersion: 1,
                configKey: 1,
            }),
        ).toThrow(/EnclaveInstanceRegistered/);
    });

    it("throws when event JSON is malformed (public key missing)", () => {
        const events = [makeRegisteredEvent({ public_key: "not-valid" })];
        expect(() =>
            readEnclaveRegistrationMetadata(events, {
                expectedFamily: 3,
                expectedVersion: 1,
                configKey: 1,
            }),
        ).toThrow(/malformed/);
    });
});

// --- requireRegistrationMetadata ---

describe("requireRegistrationMetadata", () => {
    it("passes when verifier_config_key matches expected", () => {
        const input: EnclaveVerificationMetadata = {
            verifier_config_key: 1,
            verifier_config_version: 5,
            enclave_instance_public_key: VALID_PUBLIC_KEY_HEX,
        };
        expect(requireRegistrationMetadata(input, 1)).toEqual(input);
    });

    it("throws when verifier_config_key does not match", () => {
        const input: EnclaveVerificationMetadata = {
            verifier_config_key: 1,
            verifier_config_version: 5,
            enclave_instance_public_key: VALID_PUBLIC_KEY_HEX,
        };
        expect(() => requireRegistrationMetadata(input, 2)).toThrow(/malformed/);
    });

    it("throws on malformed input (missing fields)", () => {
        expect(() => requireRegistrationMetadata({ verifier_config_key: 1 }, 1)).toThrow(
            /malformed/,
        );
    });

    it("throws on non-object input", () => {
        expect(() => requireRegistrationMetadata(null, 1)).toThrow(/malformed/);
    });
});

// --- createSuiEnclaveRegistrationTransaction ---

describe("createSuiEnclaveRegistrationTransaction", () => {
    const validInput = {
        target: "0xabc::verifier::register_enclave_instance",
        verifierRegistry: "0x00000000000000000000000000000000000000000000000000000000000000ab",
        attestationDocumentBytes: [1, 2, 3, 4],
        expiresAtMs: 1_900_000_000_000,
        senderAddress: "0x00000000000000000000000000000000000000000000000000000000000000cd",
    };

    it("creates a Transaction with specified target", () => {
        const tx = createSuiEnclaveRegistrationTransaction(validInput);
        const data = tx.getData();
        const serialized = JSON.stringify(data);
        // load_nitro_attestation is always the first move call, target is the second.
        expect(serialized).toContain("load_nitro_attestation");
        expect(serialized).toContain("register_enclave_instance");
    });

    const registrationArgs = (tx: ReturnType<typeof createSuiEnclaveRegistrationTransaction>) => {
        const command = tx.getData().commands.at(-1);
        if (command?.$kind !== "MoveCall") {
            throw new Error("expected the registration MoveCall to be the last command");
        }
        return command.MoveCall.arguments;
    };

    it("places config_key as the second argument before the document", () => {
        // register_enclave_instance_for_config(registry, config_key, document, expires_at_ms)
        const args = registrationArgs(
            createSuiEnclaveRegistrationTransaction({ ...validInput, configKey: 42 }),
        );
        expect(args).toHaveLength(4);
        expect(args[0]?.$kind).toBe("Input"); // registry object
        expect(args[1]?.$kind).toBe("Input"); // config_key (pure u64)
        expect(args[2]?.$kind).toBe("Result"); // document (load_nitro_attestation)
        expect(args[3]?.$kind).toBe("Input"); // expires_at_ms (pure u64)
    });

    it("omits config_key for the earthquake-compatible ABI", () => {
        // register_enclave_instance(registry, document, expires_at_ms)
        const args = registrationArgs(createSuiEnclaveRegistrationTransaction(validInput));
        expect(args).toHaveLength(3);
        expect(args[0]?.$kind).toBe("Input"); // registry object
        expect(args[1]?.$kind).toBe("Result"); // document immediately after registry
        expect(args[2]?.$kind).toBe("Input"); // expires_at_ms (pure u64)
    });
});

// --- readEnclaveRegistrationMetadata via execution response ---

function makeSuccessResponse(
    events: EnclaveRegistrationEvent[],
): EnclaveRegistrationExecutionResponse {
    return {
        $kind: "Transaction",
        Transaction: {
            status: { success: true },
            effects: {},
            events,
        },
    };
}

describe("readEnclaveRegistrationMetadata via execution response", () => {
    it("parses metadata from a successful Sui execution response (earthquake)", () => {
        const response = makeSuccessResponse([makeRegisteredEvent()]);
        const events =
            (
                response as {
                    $kind: string;
                    Transaction: { events?: EnclaveRegistrationEvent[] };
                }
            ).Transaction.events ?? [];
        const result = readEnclaveRegistrationMetadata(events, {
            expectedFamily: 3,
            expectedVersion: 1,
            configKey: 1,
        });
        expect(result.verifier_config_key).toBe(1);
    });
});

// ---- test doubles ----

class RecordingAutoScalingClient {
    readonly capacities: number[] = [];

    async setDesiredCapacity(input: { desiredCapacity: number }): Promise<void> {
        this.capacities.push(input.desiredCapacity);
    }
}

class RecordingEc2Client {
    async listRunnerInstances(): Promise<Array<{ instanceId: string; state: string }>> {
        return [
            { instanceId: "i-stopped", state: "stopped" },
            { instanceId: "i-ready", state: "running" },
        ];
    }
}

class RecordingSsmClient {
    readonly commands: Array<{ instanceId: string; shellCommand: string }> = [];

    async listOnlineManagedInstanceIds(): Promise<Set<string>> {
        return new Set(["i-ready"]);
    }

    async checkRunnerBootstrapReady(instanceId: string): Promise<boolean> {
        return instanceId === "i-ready";
    }

    async sendCommand(input: {
        instanceId: string;
        shellCommand: string;
    }): Promise<{ commandId: string }> {
        this.commands.push(input);
        return { commandId: "cmd-1" };
    }

    async getCommandInvocation(): Promise<{ status: string }> {
        return { status: "Success" };
    }
}

class RecordingS3Client {
    async getObjectText(): Promise<string> {
        return '{"status":"ok"}';
    }
}

class InMemorySharedRunnerLeaseStore implements SharedRunnerLeaseStore {
    private lease:
        | {
              owner: string;
              expiresAtSeconds: number;
          }
        | undefined;

    async acquire(input: {
        leaseId: string;
        owner: string;
        nowSeconds: number;
        expiresAtSeconds: number;
    }): Promise<void> {
        if (
            this.lease !== undefined &&
            this.lease.owner !== input.owner &&
            this.lease.expiresAtSeconds >= input.nowSeconds
        ) {
            throw new Error("shared runner is already leased by another verifier workflow");
        }
        this.lease = { owner: input.owner, expiresAtSeconds: input.expiresAtSeconds };
    }

    async release(input: { leaseId: string; owner: string }): Promise<boolean> {
        if (this.lease?.owner !== input.owner) {
            return false;
        }
        this.lease = undefined;
        return true;
    }
}
