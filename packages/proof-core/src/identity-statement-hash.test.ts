import { describe, expect, it } from "vitest";
import {
    computeIdentityStatementHash,
    IDENTITY_DUPLICATE_ACCOUNT_STATEMENT,
} from "./identity-statement-hash.js";

describe("computeIdentityStatementHash", () => {
    it("exposes a non-empty duplicate-account statement", () => {
        expect(IDENTITY_DUPLICATE_ACCOUNT_STATEMENT.length).toBeGreaterThan(0);
    });

    it("is deterministic for the same terms version", () => {
        expect(computeIdentityStatementHash(1)).toBe(computeIdentityStatementHash(1));
    });

    it("returns a 0x-prefixed hashToField value (top byte zeroed, 32 bytes)", () => {
        const hash = computeIdentityStatementHash(1);
        expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(hash.startsWith("0x00")).toBe(true);
    });

    it("reflects the terms version in the digest", () => {
        expect(computeIdentityStatementHash(1)).not.toBe(computeIdentityStatementHash(2));
    });

    it("treats terms version 0 as valid and distinct", () => {
        const zero = computeIdentityStatementHash(0);
        expect(zero).toMatch(/^0x[0-9a-f]{64}$/);
        expect(zero).not.toBe(computeIdentityStatementHash(1));
    });

    it("rejects a negative terms version", () => {
        expect(() => computeIdentityStatementHash(-1)).toThrow(
            "termsVersion must be a non-negative safe integer",
        );
    });

    it("rejects a non-integer terms version", () => {
        expect(() => computeIdentityStatementHash(1.5)).toThrow(
            "termsVersion must be a non-negative safe integer",
        );
    });

    it("rejects NaN terms version", () => {
        expect(() => computeIdentityStatementHash(Number.NaN)).toThrow(
            "termsVersion must be a non-negative safe integer",
        );
    });

    it("rejects a non-safe-integer terms version", () => {
        expect(() => computeIdentityStatementHash(Number.MAX_SAFE_INTEGER + 1)).toThrow(
            "termsVersion must be a non-negative safe integer",
        );
    });
});
