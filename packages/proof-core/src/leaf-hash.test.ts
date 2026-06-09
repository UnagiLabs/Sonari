import { describe, expect, it } from "vitest";
import { sha256Hex } from "./bytes.js";
import { hashLeafBytes } from "./leaf-hash.js";

describe("hashLeafBytes", () => {
    it("for empty bytes, equals sha256 of single 0x00 byte", () => {
        const expected = sha256Hex(Uint8Array.of(0x00));
        const actual = hashLeafBytes(new Uint8Array());
        expect(actual).toBe(expected);
    });

    it("prepends 0x00 domain separator before hashing", () => {
        const leafBytes = Uint8Array.of(0x01, 0x02, 0x03);
        const prefixed = new Uint8Array(1 + leafBytes.length);
        prefixed[0] = 0x00;
        prefixed.set(leafBytes, 1);
        const expected = sha256Hex(prefixed);
        const actual = hashLeafBytes(leafBytes);
        expect(actual).toBe(expected);
    });

    it("returns a 0x-prefixed 32-byte hex string", () => {
        const result = hashLeafBytes(Uint8Array.of(0xaa, 0xbb));
        expect(result.startsWith("0x")).toBe(true);
        expect(result.length).toBe(66);
    });
});
