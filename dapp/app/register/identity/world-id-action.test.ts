import { afterEach, describe, expect, it, vi } from "vitest";

describe("WORLD_ID_ACTION", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it("defaults to the audited action when env is unset or blank", async () => {
        vi.stubEnv("NEXT_PUBLIC_WORLD_ID_ACTION", "");
        const blank = await import("./world-id-action");
        expect(blank.WORLD_ID_ACTION).toBe("sonari_membership_register_v2");

        vi.resetModules();
        vi.unstubAllEnvs();
        const unset = await import("./world-id-action");
        expect(unset.WORLD_ID_ACTION).toBe("sonari_membership_register_v2");
    });

    it("accepts a valid configured action", async () => {
        vi.stubEnv("NEXT_PUBLIC_WORLD_ID_ACTION", "sonari_membership_register_v3");

        const { WORLD_ID_ACTION } = await import("./world-id-action");

        expect(WORLD_ID_ACTION).toBe("sonari_membership_register_v3");
    });

    it("fails closed when the configured action is invalid", async () => {
        vi.stubEnv("NEXT_PUBLIC_WORLD_ID_ACTION", "attacker_action");

        await expect(import("./world-id-action")).rejects.toThrow(
            "NEXT_PUBLIC_WORLD_ID_ACTION must match sonari_membership_register_v<N>",
        );
    });
});
