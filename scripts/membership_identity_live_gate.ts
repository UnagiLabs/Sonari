import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export type LiveGateStatus = "ok" | "fail";

export interface LiveGateCheck {
    readonly name: string;
    readonly status: LiveGateStatus;
    readonly message: string;
}

export interface MembershipIdentityLiveGateResult {
    readonly ok: boolean;
    readonly checks: LiveGateCheck[];
}

export interface MembershipIdentityLiveGateOptions {
    readonly env?: Record<string, string | undefined>;
    readonly checkEvidencePath?: boolean;
}

const REQUIRED_ENV_NAMES = [
    "STACK_NAME",
    "AWS_REGION",
    "LAMBDA_CODE_S3_BUCKET",
    "LAMBDA_CODE_S3_KEY",
    "TEE_ARTIFACT_S3_BUCKET",
    "TEE_ARTIFACT_S3_KEY",
    "TEE_ARTIFACT_SHA256",
    "TEE_EIF_S3_BUCKET",
    "TEE_EIF_S3_KEY",
    "TEE_EIF_SHA256",
    "NITRO_ENCLAVE_IMAGE_SHA384",
    "NITRO_ENCLAVE_PCR3",
    "SIGNING_SEED_CIPHERTEXT_S3_BUCKET",
    "SIGNING_SEED_CIPHERTEXT_S3_KEY",
    "SONARI_WORLD_ID_APP_ID",
    "SONARI_WORLD_ID_API_BASE",
    "SONARI_WORLD_ID_NULLIFIER_HASH",
    "SONARI_WORLD_ID_MERKLE_ROOT",
    "SONARI_WORLD_ID_PROOF",
    "SONARI_WORLD_ID_VERIFICATION_LEVEL",
    "SONARI_WORLD_ID_ACTION",
    "SONARI_WORLD_ID_SIGNAL_HASH",
    "SONARI_IDENTITY_PACKAGE_ID",
    "SONARI_IDENTITY_PAUSE_STATE_ID",
    "SONARI_IDENTITY_REGISTRY_ID",
    "SONARI_MEMBERSHIP_REGISTRY_ID",
    "SONARI_VERIFIER_REGISTRY_ID",
    "SONARI_MEMBERSHIP_PASS_ID",
    "RELAYER_NETWORK",
    "RELAYER_GRPC_URL",
    "RELAYER_SENDER_ADDRESS",
    "RELAYER_MODE",
    "RELAYER_ALLOW_SUBMIT",
    "RELAYER_SIGNER_SECRET_ARN",
    "SONARI_LIVE_EVIDENCE_PATH",
] as const;

const SHA256_ENV_NAMES = ["TEE_ARTIFACT_SHA256", "TEE_EIF_SHA256"] as const;
const SHA384_ENV_NAMES = ["NITRO_ENCLAVE_IMAGE_SHA384", "NITRO_ENCLAVE_PCR3"] as const;
const SUI_OBJECT_ID_ENV_NAMES = [
    "SONARI_IDENTITY_PACKAGE_ID",
    "SONARI_IDENTITY_PAUSE_STATE_ID",
    "SONARI_IDENTITY_REGISTRY_ID",
    "SONARI_MEMBERSHIP_REGISTRY_ID",
    "SONARI_VERIFIER_REGISTRY_ID",
    "SONARI_MEMBERSHIP_PASS_ID",
] as const;

export async function validateMembershipIdentityLiveGate(
    options: MembershipIdentityLiveGateOptions = {},
): Promise<MembershipIdentityLiveGateResult> {
    const env = options.env ?? process.env;
    const checks: LiveGateCheck[] = [];

    for (const name of REQUIRED_ENV_NAMES) {
        checks.push(checkRequired(name, env[name]));
    }
    checks.push(checkAwsCredentialPresence(env));
    for (const name of SHA256_ENV_NAMES) {
        checks.push(checkHexLength(name, env[name], 64));
    }
    for (const name of SHA384_ENV_NAMES) {
        checks.push(checkHexLength(name, env[name], 96));
    }
    for (const name of SUI_OBJECT_ID_ENV_NAMES) {
        checks.push(checkSuiObjectId(name, env[name]));
    }
    checks.push(checkSuiObjectId("SONARI_SUI_CLOCK_ID", env.SONARI_SUI_CLOCK_ID ?? "0x6"));
    checks.push(checkWorldIdAction(env.SONARI_WORLD_ID_ACTION));
    checks.push(checkHttpsUrl("SONARI_WORLD_ID_API_BASE", env.SONARI_WORLD_ID_API_BASE));
    checks.push(checkRelayerNetwork(env.RELAYER_NETWORK));
    checks.push(checkRelayerGrpcUrl(env.RELAYER_NETWORK, env.RELAYER_GRPC_URL));
    checks.push(checkRelayerSubmitGuard(env.RELAYER_MODE, env.RELAYER_ALLOW_SUBMIT));

    if (options.checkEvidencePath === true && isNonEmptyString(env.SONARI_LIVE_EVIDENCE_PATH)) {
        checks.push(
            await checkPathExists("SONARI_LIVE_EVIDENCE_PATH", env.SONARI_LIVE_EVIDENCE_PATH),
        );
    }

    return {
        ok: checks.every((check) => check.status === "ok"),
        checks,
    };
}

function checkRequired(name: string, value: string | undefined): LiveGateCheck {
    if (isNonEmptyString(value)) {
        return { name, status: "ok", message: "configured" };
    }
    return { name, status: "fail", message: `${name} is required for issue #74 live verification` };
}

function checkAwsCredentialPresence(env: Record<string, string | undefined>): LiveGateCheck {
    if (
        isNonEmptyString(env.AWS_PROFILE) ||
        (isNonEmptyString(env.AWS_ACCESS_KEY_ID) && isNonEmptyString(env.AWS_SECRET_ACCESS_KEY)) ||
        isNonEmptyString(env.AWS_WEB_IDENTITY_TOKEN_FILE)
    ) {
        return { name: "AWS_CREDENTIALS", status: "ok", message: "configured" };
    }
    return {
        name: "AWS_CREDENTIALS",
        status: "fail",
        message: "AWS_PROFILE, AWS access keys, or AWS_WEB_IDENTITY_TOKEN_FILE is required",
    };
}

function checkHexLength(name: string, value: string | undefined, hexLength: number): LiveGateCheck {
    if (typeof value === "string" && new RegExp(`^[0-9a-fA-F]{${hexLength}}$`).test(value)) {
        return { name, status: "ok", message: `${hexLength}-hex configured` };
    }
    return { name, status: "fail", message: `${name} must be ${hexLength} hex characters` };
}

function checkSuiObjectId(name: string, value: string | undefined): LiveGateCheck {
    if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) {
        return { name, status: "ok", message: "0x object id configured" };
    }
    return { name, status: "fail", message: `${name} must be a 0x-prefixed hex object id` };
}

function checkWorldIdAction(value: string | undefined): LiveGateCheck {
    if (value === "sonari_membership_register_v1") {
        return { name: "SONARI_WORLD_ID_ACTION", status: "ok", message: value };
    }
    return {
        name: "SONARI_WORLD_ID_ACTION",
        status: "fail",
        message: "SONARI_WORLD_ID_ACTION must be sonari_membership_register_v1",
    };
}

function checkHttpsUrl(name: string, value: string | undefined): LiveGateCheck {
    if (!isNonEmptyString(value)) {
        return { name, status: "fail", message: `${name} is required` };
    }
    try {
        const url = new URL(value);
        if (url.protocol === "https:") {
            return { name, status: "ok", message: "https URL configured" };
        }
    } catch {
        // Fall through to fail.
    }
    return { name, status: "fail", message: `${name} must be a valid https URL` };
}

function checkRelayerNetwork(value: string | undefined): LiveGateCheck {
    if (value === "testnet" || value === "mainnet" || value === "devnet") {
        return { name: "RELAYER_NETWORK", status: "ok", message: value };
    }
    return { name: "RELAYER_NETWORK", status: "fail", message: "RELAYER_NETWORK is invalid" };
}

function checkRelayerGrpcUrl(
    network: string | undefined,
    value: string | undefined,
): LiveGateCheck {
    if (!isNonEmptyString(value)) {
        return {
            name: "RELAYER_GRPC_URL",
            status: "fail",
            message: "RELAYER_GRPC_URL is required",
        };
    }
    try {
        const url = new URL(value);
        if (url.protocol !== "https:") {
            return {
                name: "RELAYER_GRPC_URL",
                status: "fail",
                message: "RELAYER_GRPC_URL must use https",
            };
        }
        if (network === "testnet" || network === "mainnet" || network === "devnet") {
            const expectedHost = `fullnode.${network}.sui.io`;
            if (url.hostname !== expectedHost) {
                return {
                    name: "RELAYER_GRPC_URL",
                    status: "fail",
                    message: `host ${url.hostname} does not match RELAYER_NETWORK=${network}`,
                };
            }
        }
        return { name: "RELAYER_GRPC_URL", status: "ok", message: "configured" };
    } catch {
        return {
            name: "RELAYER_GRPC_URL",
            status: "fail",
            message: "RELAYER_GRPC_URL must be a valid URL",
        };
    }
}

function checkRelayerSubmitGuard(
    mode: string | undefined,
    allowSubmit: string | undefined,
): LiveGateCheck {
    if (mode !== "submit") {
        return {
            name: "RELAYER_MODE",
            status: "fail",
            message: "RELAYER_MODE must be submit for issue #74 live close-out",
        };
    }
    if (allowSubmit !== "true") {
        return {
            name: "RELAYER_ALLOW_SUBMIT",
            status: "fail",
            message: "RELAYER_ALLOW_SUBMIT=true is required",
        };
    }
    return { name: "RELAYER_SUBMIT_GUARD", status: "ok", message: "submit explicitly enabled" };
}

async function checkPathExists(name: string, value: string): Promise<LiveGateCheck> {
    try {
        await access(value);
        return { name, status: "ok", message: "path exists" };
    } catch {
        return { name, status: "fail", message: `${name} path does not exist: ${value}` };
    }
}

function isNonEmptyString(value: string | undefined): value is string {
    return typeof value === "string" && value.length > 0;
}

async function main(): Promise<void> {
    const checkEvidencePath = process.argv.includes("--check-evidence-path");
    const result = await validateMembershipIdentityLiveGate({ checkEvidencePath });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) {
        process.exitCode = 1;
    }
}

const mainPath = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (import.meta.url === mainPath) {
    main().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
