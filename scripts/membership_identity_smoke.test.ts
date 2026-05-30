import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import {
    type MembershipIdentitySmokeOutput,
    runMembershipIdentitySmoke,
} from "./membership_identity_smoke.js";

describe("membership identity smoke", () => {
    let output: MembershipIdentitySmokeOutput;

    beforeAll(async () => {
        output = await runMembershipIdentitySmoke();
    }, 60_000);

    it("accepts KYC and World ID verified fixtures", async () => {
        expect(output.scope).toBe("membership identity verifier fixture smoke");
        expect(output.cases).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: "kyc_success",
                    provider: "kyc",
                    verified: true,
                    result_status: "verified",
                    payout_recipient: "membership_sbt_owner",
                    bcs_match: true,
                }),
                expect.objectContaining({
                    name: "world_id_success",
                    provider: "world_id",
                    verified: true,
                    result_status: "verified",
                    payout_recipient: "membership_sbt_owner",
                    bcs_match: true,
                }),
            ]),
        );
    });

    it("keeps reject fixtures out of verified state", async () => {
        expect(output.cases).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: "kyc_reject",
                    provider: "kyc",
                    verified: false,
                    result_status: "rejected",
                    skipped_reason: "not a verified payload",
                }),
                expect.objectContaining({
                    name: "world_id_reject",
                    provider: "world_id",
                    verified: false,
                    result_status: "rejected",
                    skipped_reason: "not a verified payload",
                }),
            ]),
        );
    });

    it("does not expose payload hex for reject fixtures", async () => {
        for (const smokeCase of output.cases) {
            if (smokeCase.result_status === "rejected") {
                expect(smokeCase).not.toHaveProperty("payload_bcs_hex");
                expect(smokeCase).not.toHaveProperty("ts_payload_bcs_hex");
                expect(smokeCase).not.toHaveProperty("rust_payload_bcs_hex");
            }
        }
    });

    it("confirms membership-tee encode-only rejects non-verified fixtures", async () => {
        const rejectFixturePaths = [
            "nautilus/verifiers/membership/fixtures/identity/kyc_reject.json",
            "nautilus/verifiers/membership/fixtures/identity/world_id_reject.json",
        ];

        for (const fixturePath of rejectFixturePaths) {
            const fixture = await readFile(fixturePath, "utf8");
            const result = await runMembershipTeeEncodeOnly(fixture);

            expect(result.code).not.toBe(0);
            expect(result.stderr).toContain("requires a verified result");
        }
    }, 60_000);

    it("does not expose legacy registration fee, payout address, or confidence discount terms", async () => {
        const serialized = JSON.stringify(output);

        expect(serialized).not.toMatch(/registration[_ -]?fee/i);
        expect(serialized).not.toMatch(/payout[_ -]?address/i);
        expect(serialized).not.toMatch(/residence[_ -]?confidence/i);
        expect(serialized).not.toMatch(/confidence[_ -]?discount/i);
    });

    it("matches membership-tee encode-only BCS for every verified fixture", async () => {
        const verifiedCases = output.cases.filter((smokeCase) => smokeCase.verified);

        expect(verifiedCases).toHaveLength(2);
        for (const smokeCase of verifiedCases) {
            expect(smokeCase).toMatchObject({
                bcs_match: true,
                payload_bcs_hex: smokeCase.ts_payload_bcs_hex,
                rust_payload_bcs_hex: smokeCase.ts_payload_bcs_hex,
            });
        }
    }, 60_000);
});

async function runMembershipTeeEncodeOnly(input: string): Promise<{
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
}> {
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
            resolve({ code, stdout, stderr });
        });
        child.stdin.end(input);
    });
}
