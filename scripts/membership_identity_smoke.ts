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

export interface MembershipIdentitySmokeCase {
    readonly name: (typeof FIXTURE_NAMES)[number];
    readonly provider: IdentityProvider;
    readonly verified: boolean;
    readonly result_status: MembershipIdentitySmokeStatus;
    readonly payout_recipient: "membership_sbt_owner";
    readonly payload_bcs_hex: string;
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

function buildSmokeCase(
    name: MembershipIdentitySmokeCase["name"],
    result: IdentityVerificationResult,
): MembershipIdentitySmokeCase {
    return {
        name,
        provider: result.provider,
        verified: result.verified,
        result_status: result.verified ? "verified" : "rejected",
        payout_recipient: "membership_sbt_owner",
        payload_bcs_hex: encodeIdentityVerificationResultBcsHex(result),
    };
}

function resolveFromCwd(inputPath: string): string {
    return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
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
