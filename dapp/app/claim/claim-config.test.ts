import { describe, expect, it } from "vitest";
import { readClaimConfig } from "./claim-config";

const PACKAGE_ID = `0x${"aa".repeat(32)}`;
const WORLD_ID_RP_ID = "rp_staging_123";

describe("readClaimConfig", () => {
    it("returns ok with package ID and World ID config", () => {
        const result = readClaimConfig({
            NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID: PACKAGE_ID,
            NEXT_PUBLIC_WORLD_ID_RP_ID: WORLD_ID_RP_ID,
            NEXT_PUBLIC_WORLD_ID_ACTION: "sonari_membership_register_v3",
        });

        expect(result).toEqual({
            kind: "ok",
            config: {
                packageId: PACKAGE_ID,
                worldIdRpId: WORLD_ID_RP_ID,
                worldIdAction: "sonari_membership_register_v3",
            },
        });
    });

    it("uses the default World ID action when env is blank", () => {
        const result = readClaimConfig({
            NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID: PACKAGE_ID,
            NEXT_PUBLIC_WORLD_ID_RP_ID: WORLD_ID_RP_ID,
            NEXT_PUBLIC_WORLD_ID_ACTION: " ",
        });

        expect(result.kind).toBe("ok");
        if (result.kind === "ok") {
            expect(result.config.worldIdAction).toBe("sonari_membership_register_v2");
        }
    });

    it("returns missing fields instead of unsafe fallbacks", () => {
        const result = readClaimConfig({
            NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID: "",
            NEXT_PUBLIC_WORLD_ID_RP_ID: "",
        });

        expect(result).toEqual({
            kind: "missing",
            fields: [
                "NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID",
                "NEXT_PUBLIC_WORLD_ID_RP_ID",
            ],
        });
    });

    it("does not require individual object ID env vars", () => {
        const result = readClaimConfig({
            NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID: PACKAGE_ID,
            NEXT_PUBLIC_WORLD_ID_RP_ID: WORLD_ID_RP_ID,
        });

        expect(result.kind).toBe("ok");
    });

    it("rejects malformed object IDs and action names", () => {
        expect(
            readClaimConfig({
                NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID: "not-an-id",
                NEXT_PUBLIC_WORLD_ID_RP_ID: WORLD_ID_RP_ID,
            }),
        ).toEqual({
            kind: "invalid",
            message: "NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID must be a 32-byte object id.",
        });

        expect(
            readClaimConfig({
                NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID: PACKAGE_ID,
                NEXT_PUBLIC_WORLD_ID_RP_ID: WORLD_ID_RP_ID,
                NEXT_PUBLIC_WORLD_ID_ACTION: "bad action",
            }),
        ).toEqual({
            kind: "invalid",
            message: "NEXT_PUBLIC_WORLD_ID_ACTION must match sonari_membership_register_v<N>",
        });
    });
});
