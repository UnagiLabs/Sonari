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
