import { describe, expect, it } from "vitest";
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
});
