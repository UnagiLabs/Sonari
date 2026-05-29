import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
    name: string;
    status: DoctorStatus;
    message: string;
}

export interface OracleDoctorOptions {
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    templatePath?: string;
}

export interface OracleDoctorResult {
    ok: boolean;
    checks: DoctorCheck[];
}

const DEFAULT_TEMPLATE_PATH = "infra/aws/earthquake-runner/template.yaml";
const RELAYER_MODES = new Set(["", "preview", "dry_run", "submit"]);
const RELAYER_NETWORKS = new Set(["mainnet", "testnet", "devnet"]);

export async function runOracleDoctor(
    options: OracleDoctorOptions = {},
): Promise<OracleDoctorResult> {
    const env = options.env ?? process.env;
    const checks: DoctorCheck[] = [];

    checks.push(checkRelayerMode(env.RELAYER_MODE));
    checks.push(checkRelayerNetwork(env.RELAYER_NETWORK, env.RELAYER_MODE));
    checks.push(checkBooleanFlag("RELAYER_ALLOW_SUBMIT", env.RELAYER_ALLOW_SUBMIT));
    checks.push(
        checkRelayerGrpcUrl(env.RELAYER_GRPC_URL, env.RELAYER_NETWORK, env.RELAYER_MODE),
    );
    checks.push(
        checkRequiredForMode(
            "RELAYER_SENDER_ADDRESS",
            env.RELAYER_SENDER_ADDRESS,
            env.RELAYER_MODE,
        ),
    );
    checks.push(
        checkSubmitGuard(
            env.RELAYER_MODE,
            env.RELAYER_ALLOW_SUBMIT,
            env.RELAYER_SIGNER_SECRET_ARN,
        ),
    );
    checks.push(checkOptionalSecretPair("MANUAL_SUBMIT_TOKEN", env.MANUAL_SUBMIT_TOKEN));
    checks.push(checkOptionalSecretPair("RUNNER_TOKEN_SECRET_ARN", env.RUNNER_TOKEN_SECRET_ARN));
    checks.push(checkOptionalSecretPair("EVENTS_TABLE_NAME", env.EVENTS_TABLE_NAME));
    checks.push(checkOptionalSecretPair("RUNNER_STATE_MACHINE_ARN", env.RUNNER_STATE_MACHINE_ARN));
    checks.push(checkOptionalSecretPair("RESULT_BUCKET", env.RESULT_BUCKET));
    checks.push(checkOptionalSecretPair("RUNNER_ASG_NAME", env.RUNNER_ASG_NAME));
    checks.push(
        checkOptionalSecretPair("NITRO_ENCLAVE_PROCESS_COMMAND", env.NITRO_ENCLAVE_PROCESS_COMMAND),
    );
    checks.push(await checkAwsOnlyTemplate(options.templatePath ?? DEFAULT_TEMPLATE_PATH));

    return {
        ok: checks.every((check) => check.status !== "fail"),
        checks,
    };
}

function checkRelayerMode(value: string | undefined): DoctorCheck {
    const mode = value ?? "";
    if (!RELAYER_MODES.has(mode)) {
        return {
            name: "RELAYER_MODE",
            status: "fail",
            message: `unsupported mode: ${mode}`,
        };
    }
    return {
        name: "RELAYER_MODE",
        status: "ok",
        message: mode.length === 0 ? "disabled" : mode,
    };
}

function checkRelayerNetwork(
    value: string | undefined,
    modeValue: string | undefined,
): DoctorCheck {
    const mode = modeValue ?? "";
    if (mode !== "dry_run" && mode !== "submit") {
        return {
            name: "RELAYER_NETWORK",
            status: "warn",
            message: "not required when relayer is disabled",
        };
    }
    if (value !== undefined && RELAYER_NETWORKS.has(value)) {
        return { name: "RELAYER_NETWORK", status: "ok", message: value };
    }
    return {
        name: "RELAYER_NETWORK",
        status: "fail",
        message: "required for RELAYER_MODE=dry_run or submit",
    };
}

function checkBooleanFlag(name: string, value: string | undefined): DoctorCheck {
    if (value === "true") {
        return { name, status: "ok", message: "enabled" };
    }
    if (value === undefined || value.length === 0 || value === "false") {
        return { name, status: "warn", message: "not enabled" };
    }
    return { name, status: "fail", message: "must be true or false when set" };
}

function checkRequiredForMode(
    name: string,
    value: string | undefined,
    modeValue: string | undefined,
): DoctorCheck {
    const mode = modeValue ?? "preview";
    if (mode !== "dry_run") {
        return { name, status: "warn", message: "not required outside dry_run mode" };
    }
    if (value !== undefined && value.length > 0) {
        return { name, status: "ok", message: "configured" };
    }
    return { name, status: "fail", message: "required for RELAYER_MODE=dry_run" };
}

function checkRelayerGrpcUrl(
    value: string | undefined,
    network: string | undefined,
    modeValue: string | undefined,
): DoctorCheck {
    const mode = modeValue ?? "";
    if (mode !== "dry_run" && mode !== "submit") {
        return {
            name: "RELAYER_GRPC_URL",
            status: "warn",
            message: "not required when relayer is disabled",
        };
    }
    if (value === undefined || value.length === 0) {
        return {
            name: "RELAYER_GRPC_URL",
            status: "fail",
            message: `required for RELAYER_MODE=${mode}`,
        };
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return { name: "RELAYER_GRPC_URL", status: "fail", message: "must be a valid URL" };
    }
    if (url.protocol !== "https:") {
        return { name: "RELAYER_GRPC_URL", status: "fail", message: "must use https" };
    }
    if (network !== undefined && RELAYER_NETWORKS.has(network)) {
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
}

function checkSubmitGuard(
    modeValue: string | undefined,
    allowSubmit: string | undefined,
    signerSecretArn: string | undefined,
): DoctorCheck {
    const mode = modeValue ?? "";
    if (mode !== "submit") {
        return {
            name: "RELAYER_SUBMIT_GUARD",
            status: "warn",
            message: "not required outside submit mode",
        };
    }
    if (allowSubmit !== "true") {
        return {
            name: "RELAYER_SUBMIT_GUARD",
            status: "fail",
            message: "RELAYER_ALLOW_SUBMIT=true is required for submit",
        };
    }
    if (signerSecretArn === undefined || signerSecretArn.length === 0) {
        return {
            name: "RELAYER_SUBMIT_GUARD",
            status: "fail",
            message: "RELAYER_SIGNER_SECRET_ARN is required for submit",
        };
    }
    return { name: "RELAYER_SUBMIT_GUARD", status: "ok", message: "submit guard configured" };
}

function checkOptionalSecretPair(name: string, value: string | undefined): DoctorCheck {
    if (value !== undefined && value.length > 0) {
        return { name, status: "ok", message: "configured" };
    }
    return { name, status: "warn", message: "not configured" };
}

async function checkAwsOnlyTemplate(templatePath: string): Promise<DoctorCheck> {
    try {
        const template = await readFile(templatePath, "utf8");
        const missing = [
            "AWS::DynamoDB::Table",
            "AWS::S3::Bucket",
            "AWS::Lambda::Function",
            "AWS::StepFunctions::StateMachine",
            "AWS::Scheduler::Schedule",
        ].filter((needle) => !template.includes(needle));
        if (template.includes("AWS::ElasticLoadBalancingV2") || template.includes("ToPort: 8789")) {
            return {
                name: "AWS_ONLY_TEMPLATE",
                status: "fail",
                message: "template still exposes the legacy ALB/HTTP runner path",
            };
        }
        if (missing.length > 0) {
            return {
                name: "AWS_ONLY_TEMPLATE",
                status: "fail",
                message: `missing orchestration resources: ${missing.join(", ")}`,
            };
        }
        return {
            name: "AWS_ONLY_TEMPLATE",
            status: "ok",
            message: "AWS-only Lambda/Step Functions template is present",
        };
    } catch (error) {
        return {
            name: "AWS_ONLY_TEMPLATE",
            status: "fail",
            message: error instanceof Error ? error.message : String(error),
        };
    }
}

async function main(): Promise<void> {
    const result = await runOracleDoctor();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) {
        process.exitCode = 1;
    }
}

const mainPath = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (mainPath !== null && import.meta.url === mainPath) {
    main().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
