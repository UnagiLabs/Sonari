import { describe, expect, it } from "vitest";
import { parseH3Index } from "./h3.js";

describe("parseH3Index", () => {
    it("preserves canonical decimal string as string and bigint", () => {
        expect(parseH3Index("608819013513904127", 7)).toEqual({
            decimal: "608819013513904127",
            value: 608819013513904127n,
        });
    });

    it("rejects non-canonical decimal strings and u64 overflow", () => {
        for (const value of ["", "-1", "+1", "abc", "1.2", "01", "18446744073709551616"]) {
            expect(() => parseH3Index(value, 7), value).toThrow();
        }
    });

    it("rejects resolution mismatch", () => {
        expect(() => parseH3Index("608819013513904127", 6)).toThrow(/resolution/i);
    });

    it("rejects wrong H3 mode bits", () => {
        const wrongMode = (608819013513904127n & ~(0xfn << 59n)) | (2n << 59n);
        expect(() => parseH3Index(wrongMode.toString(), 7)).toThrow(/mode/i);
    });

    it("rejects reserved bits set", () => {
        const reservedBitsSet = 608819013513904127n | (1n << 56n);
        expect(() => parseH3Index(reservedBitsSet.toString(), 7)).toThrow(/reserved/i);
    });

    it("rejects active digit of 7", () => {
        const activeDigitSeven = 608819013513904127n | (7n << 42n);
        expect(() => parseH3Index(activeDigitSeven.toString(), 7)).toThrow(/digit/i);
    });

    it("rejects unused digit not equal to 7", () => {
        const unusedDigitNotSeven = 608819013513904127n & ~(7n << 21n);
        expect(() => parseH3Index(unusedDigitNotSeven.toString(), 7)).toThrow(/unused/i);
    });

    it("rejects deleted pentagon subsequence", () => {
        expect(() => parseH3Index("608131085246660607", 7)).toThrow(/pentagon/i);
    });

    it("throws for invalid expectedResolution values", () => {
        expect(() => parseH3Index("608819013513904127", -1)).toThrow();
        expect(() => parseH3Index("608819013513904127", 16)).toThrow();
        expect(() => parseH3Index("608819013513904127", 1.5)).toThrow();
    });
});
