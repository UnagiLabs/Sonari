import { describe, expect, it } from "vitest";
import { INTERNAL_NODE_DOMAIN_SEPARATOR, LEAF_HASH_DOMAIN_SEPARATOR } from "./index.js";

describe("@sonari/proof-core package entry", () => {
    it("exposes the leaf and internal node domain separators", () => {
        expect(LEAF_HASH_DOMAIN_SEPARATOR).toBe(0x00);
        expect(INTERNAL_NODE_DOMAIN_SEPARATOR).toBe(0x01);
    });
});
