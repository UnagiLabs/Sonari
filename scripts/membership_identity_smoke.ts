import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
    encodeIdentityVerificationResultBcsHex,
    type IdentityProvider,
    type IdentityVerificationResult,
} from "../nautilus/verifiers/membership/shared/src/index.js";

const DEFAULT_FIXTURES_DIR = "nautilus/verifiers/membership/fixtures/identity";
const FIXTURE_NAMES = ["kyc_success", "world_id_success", "kyc_reject", "world_id_reject"] as const;

export type MembershipIdentitySmokeStatus = "verified" | "rejected";

export type MembershipIdentitySmokeCase =
    | MembershipIdentitySmokeVerifiedCase
    | MembershipIdentitySmokeRejectedCase;

export interface MembershipIdentitySmokeVerifiedCase {
    readonly name: (typeof FIXTURE_NAMES)[number];
    readonly provider: IdentityProvider;
    readonly verified: true;
    readonly result_status: "verified";
    readonly payout_recipient: "membership_sbt_owner";
    readonly bcs_match: true;
    readonly ts_payload_bcs_hex: string;
    readonly rust_payload_bcs_hex: string;
    readonly payload_bcs_hex: string;
}

export interface MembershipIdentitySmokeRejectedCase {
    readonly name: (typeof FIXTURE_NAMES)[number];
    readonly provider: IdentityProvider;
    readonly verified: false;
    readonly result_status: "rejected";
    readonly payout_recipient: "membership_sbt_owner";
    readonly skipped_reason: "not a verified payload";
}

export interface MembershipIdentitySmokeOutput {
    readonly scope: "membership identity verifier fixture smoke";
    readonly cases: MembershipIdentitySmokeCase[];
}

export interface MembershipIdentitySmokeOptions {
    readonly fixturesDir?: string;
}

export async function runMembershipIdentitySmoke(
    options: MembershipIdentitySmokeOptions = {},
): Promise<MembershipIdentitySmokeOutput> {
    const fixturesDir = resolveFromCwd(options.fixturesDir ?? DEFAULT_FIXTURES_DIR);
    const cases = await Promise.all(
        FIXTURE_NAMES.map(async (name) => {
            const result = await readIdentityFixture(path.join(fixturesDir, `${name}.json`));
            return buildSmokeCase(name, result);
        }),
    );

    return {
        scope: "membership identity verifier fixture smoke",
        cases,
    };
}

async function readIdentityFixture(filePath: string): Promise<IdentityVerificationResult> {
    return JSON.parse(await readFile(filePath, "utf8")) as IdentityVerificationResult;
}

async function buildSmokeCase(
    name: MembershipIdentitySmokeCase["name"],
    result: IdentityVerificationResult,
): Promise<MembershipIdentitySmokeCase> {
    if (!result.verified) {
        return {
            name,
            provider: result.provider,
            verified: false,
            result_status: "rejected",
            payout_recipient: "membership_sbt_owner",
            skipped_reason: "not a verified payload",
        };
    }

    const tsPayloadBcsHex = encodeIdentityVerificationResultBcsHex(result);
    const rustPayloadBcsHex = await encodeWithMembershipTee(result);
    if (rustPayloadBcsHex !== tsPayloadBcsHex) {
        throw new Error(
            `${name} TS/Rust payload BCS mismatch: ts=${tsPayloadBcsHex} rust=${rustPayloadBcsHex}`,
        );
    }

    return {
        name,
        provider: result.provider,
        verified: true,
        result_status: "verified",
        payout_recipient: "membership_sbt_owner",
        bcs_match: true,
        ts_payload_bcs_hex: tsPayloadBcsHex,
        rust_payload_bcs_hex: rustPayloadBcsHex,
        payload_bcs_hex: tsPayloadBcsHex,
    };
}

async function encodeWithMembershipTee(result: IdentityVerificationResult): Promise<string> {
    const stdout = await runMembershipTeeEncodeOnly(JSON.stringify(result));
    const parsed = JSON.parse(stdout) as unknown;
    if (!isRecord(parsed) || typeof parsed.payload_bcs_hex !== "string") {
        throw new Error("membership-tee --encode-only returned an invalid payload");
    }
    return parsed.payload_bcs_hex;
}

async function runMembershipTeeEncodeOnly(input: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn("cargo", ["run", "-q", "-p", "membership-tee", "--", "--encode-only"], {
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) {
                resolve(stdout);
                return;
            }
            reject(new Error(`membership-tee --encode-only failed with ${code}: ${stderr}`));
        });
        child.stdin.end(input);
    });
}

function resolveFromCwd(inputPath: string): string {
    return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

async function main(): Promise<void> {
    const output = await runMembershipIdentitySmoke();
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

const mainPath = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (mainPath !== null && import.meta.url === mainPath) {
    main().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
