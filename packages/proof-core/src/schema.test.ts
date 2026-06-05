import { describe, expect, it } from "vitest";
import {
    assertMatches,
    assertNonNegativeSafeInteger,
    expectArray,
    expectBoolean,
    expectKeys,
    expectLiteral,
    expectNonNegativeSafeInteger,
    expectPositiveSafeInteger,
    expectPrefixedHex32,
    expectRecord,
    expectString,
    type JsonRecord,
} from "./schema.js";

describe("expectRecord", () => {
    it("returns the object for a plain object", () => {
        const obj = { a: 1 };
        expect(expectRecord("test", obj)).toBe(obj);
    });

    it("throws for null", () => {
        expect(() => expectRecord("test", null)).toThrow(/must be an object/);
    });

    it("throws for arrays", () => {
        expect(() => expectRecord("test", [1, 2])).toThrow(/must be an object/);
    });

    it("throws for primitives", () => {
        expect(() => expectRecord("test", 42)).toThrow(/must be an object/);
        expect(() => expectRecord("test", "string")).toThrow(/must be an object/);
    });
});

describe("expectKeys", () => {
    it("passes for exactly matching keys", () => {
        const record: JsonRecord = { a: 1, b: 2 };
        expect(() => expectKeys("test", record, ["a", "b"])).not.toThrow();
    });

    it("throws for unexpected keys", () => {
        const record: JsonRecord = { a: 1, b: 2, c: 3 };
        expect(() => expectKeys("test", record, ["a", "b"])).toThrow(/unexpected field: c/);
    });

    it("throws for missing keys", () => {
        const record: JsonRecord = { a: 1 };
        expect(() => expectKeys("test", record, ["a", "b"])).toThrow(/missing field: b/);
    });
});

describe("expectString", () => {
    it("returns string value", () => {
        expect(expectString("test", "hello")).toBe("hello");
    });

    it("throws for non-string", () => {
        expect(() => expectString("test", 42)).toThrow(/must be a string/);
    });
});

describe("expectBoolean", () => {
    it("returns boolean value", () => {
        expect(expectBoolean("test", true)).toBe(true);
        expect(expectBoolean("test", false)).toBe(false);
    });

    it("throws for non-boolean", () => {
        expect(() => expectBoolean("test", 1)).toThrow(/must be a boolean/);
        expect(() => expectBoolean("test", "true")).toThrow(/must be a boolean/);
    });
});

describe("expectArray", () => {
    it("returns the array", () => {
        const arr = [1, 2, 3];
        expect(expectArray("test", arr)).toBe(arr);
    });

    it("throws for non-array", () => {
        expect(() => expectArray("test", { length: 0 })).toThrow(/must be an array/);
        expect(() => expectArray("test", "abc")).toThrow(/must be an array/);
    });
});

describe("expectLiteral", () => {
    it("returns the value when it matches", () => {
        expect(expectLiteral("test", "hello", "hello")).toBe("hello");
        expect(expectLiteral("test", 1, 1)).toBe(1);
    });

    it("throws when value does not match", () => {
        expect(() => expectLiteral("test", "wrong", "expected")).toThrow(/must be expected/);
        expect(() => expectLiteral("test", 2, 1)).toThrow(/must be 1/);
    });
});

describe("expectNonNegativeSafeInteger", () => {
    it("returns the integer for valid values", () => {
        expect(expectNonNegativeSafeInteger("test", 0)).toBe(0);
        expect(expectNonNegativeSafeInteger("test", 100)).toBe(100);
    });

    it("throws for negative integers", () => {
        expect(() => expectNonNegativeSafeInteger("test", -1)).toThrow(
            /must be a non-negative safe integer/,
        );
    });

    it("throws for non-integers", () => {
        expect(() => expectNonNegativeSafeInteger("test", 1.5)).toThrow(
            /must be a non-negative safe integer/,
        );
        expect(() => expectNonNegativeSafeInteger("test", "0")).toThrow(
            /must be a non-negative safe integer/,
        );
    });

    it("throws for unsafe integers", () => {
        expect(() => expectNonNegativeSafeInteger("test", Number.MAX_SAFE_INTEGER + 1)).toThrow(
            /must be a non-negative safe integer/,
        );
    });
});

describe("expectPositiveSafeInteger", () => {
    it("returns the integer for positive values", () => {
        expect(expectPositiveSafeInteger("test", 1)).toBe(1);
        expect(expectPositiveSafeInteger("test", 100)).toBe(100);
    });

    it("throws for zero", () => {
        expect(() => expectPositiveSafeInteger("test", 0)).toThrow(/must be greater than zero/);
    });

    it("throws for negative integers", () => {
        expect(() => expectPositiveSafeInteger("test", -1)).toThrow(
            /must be a non-negative safe integer/,
        );
    });
});

describe("assertNonNegativeSafeInteger", () => {
    it("passes for non-negative safe integers", () => {
        expect(() => assertNonNegativeSafeInteger("test", 0)).not.toThrow();
        expect(() => assertNonNegativeSafeInteger("test", 42)).not.toThrow();
    });

    it("throws for negative values", () => {
        expect(() => assertNonNegativeSafeInteger("test", -1)).toThrow(
            /must be a non-negative safe integer/,
        );
    });

    it("throws for non-safe integers", () => {
        expect(() => assertNonNegativeSafeInteger("test", 1.5)).toThrow(
            /must be a non-negative safe integer/,
        );
    });
});

describe("expectPrefixedHex32", () => {
    it("accepts a valid 32-byte lowercase hex string", () => {
        const valid = `0x${"a".repeat(64)}`;
        expect(expectPrefixedHex32("test", valid)).toBe(valid);
    });

    it("throws for incorrect length", () => {
        expect(() => expectPrefixedHex32("test", `0x${"a".repeat(63)}`)).toThrow(
            /must be a lowercase 0x-prefixed 32-byte hex string/,
        );
        expect(() => expectPrefixedHex32("test", `0x${"a".repeat(65)}`)).toThrow(
            /must be a lowercase 0x-prefixed 32-byte hex string/,
        );
    });

    it("throws for uppercase hex", () => {
        expect(() => expectPrefixedHex32("test", `0x${"A".repeat(64)}`)).toThrow(
            /must be a lowercase 0x-prefixed 32-byte hex string/,
        );
    });

    it("throws for missing 0x prefix", () => {
        expect(() => expectPrefixedHex32("test", "a".repeat(64))).toThrow(
            /must be a lowercase 0x-prefixed 32-byte hex string/,
        );
    });

    it("throws for non-string input", () => {
        expect(() => expectPrefixedHex32("test", 42)).toThrow(
            /must be a lowercase 0x-prefixed 32-byte hex string/,
        );
    });
});

describe("assertMatches", () => {
    it("passes when values match", () => {
        expect(() => assertMatches("test", 1, 1)).not.toThrow();
        expect(() => assertMatches("test", "a", "a")).not.toThrow();
    });

    it("throws when values differ", () => {
        expect(() => assertMatches("test", 1, 2)).toThrow(/does not match/);
        expect(() => assertMatches("test", "x", "y")).toThrow(/does not match/);
    });
});
