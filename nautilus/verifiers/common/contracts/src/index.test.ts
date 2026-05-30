import { describe, expect, it } from "vitest";
import { parseVerifierKind } from "./index.js";

describe("verifier kind contract", () => {
    it("accepts earthquake", () => {
        expect(parseVerifierKind("earthquake")).toBe("earthquake");
    });

    it("accepts membership_identity", () => {
        expect(parseVerifierKind("membership_identity")).toBe("membership_identity");
    });

    it("rejects unknown values fail-closed", () => {
        expect(() => parseVerifierKind("membership")).toThrow(/verifier_kind/);
        expect(() => parseVerifierKind(undefined)).toThrow(/verifier_kind/);
        expect(() => parseVerifierKind({ verifier_kind: "earthquake" })).toThrow(/verifier_kind/);
    });
});
