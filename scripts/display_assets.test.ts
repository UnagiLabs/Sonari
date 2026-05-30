import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const displayAssets = [
    "membership-pass.svg",
    "donor-pass.svg",
    "claim-receipt.svg",
    "disaster-event.svg",
] as const;

describe("Sui Display assets", () => {
    it("keeps every on-chain image_url target in docs/assets/display", () => {
        for (const asset of displayAssets) {
            expect(existsSync(join(process.cwd(), "docs", "assets", "display", asset))).toBe(true);
        }
    });
});
