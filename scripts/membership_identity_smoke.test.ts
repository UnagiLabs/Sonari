import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { encodeIdentityVerificationResultBcsHex } from "../nautilus/verifiers/membership/shared/src/index.js";
import { runMembershipIdentitySmoke } from "./membership_identity_smoke.js";

describe("membership identity smoke", () => {
    it("accepts KYC and World ID verified fixtures", async () => {
        const output = await runMembershipIdentitySmoke();

        expect(output.scope).toBe("membership identity verifier fixture smoke");
        expect(output.cases).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: "kyc_success",
                    provider: "kyc",
                    verified: true,
                    result_status: "verified",
                    payout_recipient: "membership_sbt_owner",
                }),
                expect.objectContaining({
                    name: "world_id_success",
                    provider: "world_id",
                    verified: true,
                    result_status: "verified",
                    payout_recipient: "membership_sbt_owner",
                }),
            ]),
        );
    });

    it("keeps reject fixtures out of verified state", async () => {
        const output = await runMembershipIdentitySmoke();

        expect(output.cases).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: "kyc_reject",
                    provider: "kyc",
                    verified: false,
                    result_status: "rejected",
                }),
                expect.objectContaining({
                    name: "world_id_reject",
                    provider: "world_id",
                    verified: false,
                    result_status: "rejected",
                }),
            ]),
        );
    });

    it("does not expose legacy registration fee, payout address, or confidence discount terms", async () => {
        const output = await runMembershipIdentitySmoke();
        const serialized = JSON.stringify(output);

        expect(serialized).not.toMatch(/registration[_ -]?fee/i);
        expect(serialized).not.toMatch(/payout[_ -]?address/i);
        expect(serialized).not.toMatch(/residence[_ -]?confidence/i);
        expect(serialized).not.toMatch(/confidence[_ -]?discount/i);
    });

    it("matches membership-tee encode-only BCS for a fixture result", async () => {
        const fixture = JSON.parse(
            await readFile(
                "nautilus/verifiers/membership/fixtures/identity/world_id_success.json",
                "utf8",
            ),
        );
        const expected = encodeIdentityVerificationResultBcsHex(fixture);
        const stdout = await runMembershipTeeEncodeOnly(JSON.stringify(fixture));

        expect(JSON.parse(stdout)).toEqual({ payload_bcs_hex: expected });
    }, 60_000);
});

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
