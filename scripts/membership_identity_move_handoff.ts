import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SUI_CLOCK_OBJECT_ID = "0x6";
const REQUIRED_ENV = [
    "SONARI_IDENTITY_PACKAGE_ID",
    "SONARI_IDENTITY_PAUSE_STATE_ID",
    "SONARI_IDENTITY_REGISTRY_ID",
    "SONARI_MEMBERSHIP_REGISTRY_ID",
    "SONARI_VERIFIER_REGISTRY_ID",
    "SONARI_MEMBERSHIP_PASS_ID",
] as const;

type RequiredEnvName = (typeof REQUIRED_ENV)[number];

export interface IdentityMoveHandoffConfig {
    readonly packageId: string;
    readonly pauseStateId: string;
    readonly identityRegistryId: string;
    readonly membershipRegistryId: string;
    readonly verifierRegistryId: string;
    readonly membershipPassId: string;
    readonly clockId: string;
}

export interface IdentityMoveHandoff {
    readonly target: string;
    readonly arguments: [
        string,
        string,
        string,
        string,
        string,
        string,
        number[],
        number[],
        number[],
    ];
    readonly suiClientCall: string[];
}

export function parseIdentityMoveHandoffEnv(
    env: Record<string, string | undefined>,
): IdentityMoveHandoffConfig {
    for (const name of REQUIRED_ENV) {
        const value = env[name];
        if (value === undefined || value.length === 0) {
            throw new Error(`Missing required env: ${name}`);
        }
        assertHexObjectId(value, name);
    }

    const clockId = env.SONARI_SUI_CLOCK_ID ?? SUI_CLOCK_OBJECT_ID;
    assertHexObjectId(clockId, "SONARI_SUI_CLOCK_ID");

    return {
        packageId: envValue(env, "SONARI_IDENTITY_PACKAGE_ID"),
        pauseStateId: envValue(env, "SONARI_IDENTITY_PAUSE_STATE_ID"),
        identityRegistryId: envValue(env, "SONARI_IDENTITY_REGISTRY_ID"),
        membershipRegistryId: envValue(env, "SONARI_MEMBERSHIP_REGISTRY_ID"),
        verifierRegistryId: envValue(env, "SONARI_VERIFIER_REGISTRY_ID"),
        membershipPassId: envValue(env, "SONARI_MEMBERSHIP_PASS_ID"),
        clockId,
    };
}

export function buildIdentityMoveHandoff(
    sidecarOutput: unknown,
    config: IdentityMoveHandoffConfig,
): IdentityMoveHandoff {
    const result = parseVerifiedSidecarOutput(sidecarOutput);
    const payloadBytes = parseHexBytes(result.payload_bcs_hex, "payload_bcs_hex");
    const signatureBytes = parseHexBytes(result.signature, "signature", 64);
    const publicKeyBytes = parseHexBytes(result.public_key, "public_key", 32);
    const target = `${config.packageId}::accessor::update_identity_verification`;
    const args: IdentityMoveHandoff["arguments"] = [
        config.pauseStateId,
        config.identityRegistryId,
        config.membershipRegistryId,
        config.verifierRegistryId,
        config.membershipPassId,
        config.clockId,
        payloadBytes,
        signatureBytes,
        publicKeyBytes,
    ];

    return {
        target,
        arguments: args,
        suiClientCall: [
            "sui",
            "client",
            "call",
            "--package",
            config.packageId,
            "--module",
            "accessor",
            "--function",
            "update_identity_verification",
            "--args",
            ...args.map(formatSuiArg),
        ],
    };
}

interface VerifiedSidecarResult {
    readonly payload_bcs_hex: string;
    readonly signature: string;
    readonly public_key: string;
}

function parseVerifiedSidecarOutput(input: unknown): VerifiedSidecarResult {
    if (!isRecord(input) || input.ok !== true || !isRecord(input.result)) {
        throw new Error("Expected verified identity sidecar output");
    }
    const result = input.result;
    if (result.status !== "verified") {
        throw new Error("Expected verified identity sidecar output");
    }
    if (
        typeof result.payload_bcs_hex !== "string" ||
        typeof result.signature !== "string" ||
        typeof result.public_key !== "string"
    ) {
        throw new Error(
            "Verified identity sidecar output requires payload_bcs_hex, signature, and public_key",
        );
    }

    return {
        payload_bcs_hex: result.payload_bcs_hex,
        signature: result.signature,
        public_key: result.public_key,
    };
}

function parseHexBytes(value: string, fieldName: string, expectedLength?: number): number[] {
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) {
        throw new Error(`${fieldName} must be 0x-prefixed even-length hex bytes`);
    }
    const hex = value.slice(2);
    const bytes: number[] = [];
    for (let offset = 0; offset < hex.length; offset += 2) {
        bytes.push(Number.parseInt(hex.slice(offset, offset + 2), 16));
    }
    if (expectedLength !== undefined && bytes.length !== expectedLength) {
        throw new Error(`${fieldName} must be ${expectedLength} bytes`);
    }
    return bytes;
}

function formatSuiArg(input: string | number[]): string {
    return Array.isArray(input) ? `[${input.join(",")}]` : input;
}

function envValue(env: Record<RequiredEnvName, string | undefined>, name: RequiredEnvName): string {
    const value = env[name];
    if (value === undefined || value.length === 0) {
        throw new Error(`Missing required env: ${name}`);
    }
    return value;
}

function assertHexObjectId(value: string, fieldName: string): void {
    if (!/^0x[0-9a-fA-F]+$/.test(value)) {
        throw new Error(`${fieldName} must be a 0x-prefixed hex object id`);
    }
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

async function readInput(argv: readonly string[]): Promise<unknown> {
    const inputFlagIndex = argv.indexOf("--input");
    if (inputFlagIndex >= 0) {
        const filePath = argv[inputFlagIndex + 1];
        if (filePath === undefined || filePath.startsWith("--")) {
            throw new Error("--input requires a file path");
        }
        return JSON.parse(await readFile(filePath, "utf8")) as unknown;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function main(): Promise<void> {
    const sidecarOutput = await readInput(process.argv.slice(2));
    const handoff = buildIdentityMoveHandoff(
        sidecarOutput,
        parseIdentityMoveHandoffEnv(process.env),
    );
    process.stdout.write(`${JSON.stringify(handoff, null, 2)}\n`);
}

const mainPath = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (mainPath !== null && import.meta.url === mainPath) {
    main().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
