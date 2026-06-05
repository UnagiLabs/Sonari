import { describe, expect, it } from "vitest";
import {
    bytesToBigEndianU64,
    bytesToPrefixedHex,
    hexToBytes,
    sha256Bytes,
    sha256Hex,
    U64_MAX,
    u64BigEndianBytes,
    u64LittleEndianBytes,
} from "./bytes.js";

describe("u64LittleEndianBytes", () => {
    it("encodes 1n as [1,0,0,0,0,0,0,0]", () => {
        expect(Array.from(u64LittleEndianBytes(1n))).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    });

    it("encodes 0n as all-zero bytes", () => {
        expect(Array.from(u64LittleEndianBytes(0n))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });

    it("encodes U64_MAX correctly", () => {
        expect(Array.from(u64LittleEndianBytes(U64_MAX))).toEqual([
            255, 255, 255, 255, 255, 255, 255, 255,
        ]);
    });

    it("throws for negative values", () => {
        expect(() => u64LittleEndianBytes(-1n)).toThrow();
    });

    it("throws for values exceeding U64_MAX", () => {
        expect(() => u64LittleEndianBytes(U64_MAX + 1n)).toThrow();
    });
});

describe("u64BigEndianBytes", () => {
    it("encodes 1n as [0,0,0,0,0,0,0,1]", () => {
        expect(Array.from(u64BigEndianBytes(1n))).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    });

    it("encodes 0n as all-zero bytes", () => {
        expect(Array.from(u64BigEndianBytes(0n))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });

    it("throws for negative values", () => {
        expect(() => u64BigEndianBytes(-1n)).toThrow();
    });

    it("throws for values exceeding U64_MAX", () => {
        expect(() => u64BigEndianBytes(U64_MAX + 1n)).toThrow();
    });
});

describe("bytesToBigEndianU64", () => {
    it("decodes [0,0,0,0,0,0,0,1] as 1n", () => {
        expect(bytesToBigEndianU64(Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 1))).toBe(1n);
    });

    it("round-trips with u64BigEndianBytes", () => {
        const value = 123456789n;
        expect(bytesToBigEndianU64(u64BigEndianBytes(value))).toBe(value);
    });

    it("throws when given fewer than 8 bytes", () => {
        expect(() => bytesToBigEndianU64(Uint8Array.of(0, 0, 0))).toThrow();
    });

    it("throws when given more than 8 bytes", () => {
        expect(() => bytesToBigEndianU64(new Uint8Array(9))).toThrow();
    });
});

describe("hexToBytes", () => {
    it("converts a 32-byte hex string to a 32-byte Uint8Array", () => {
        const hex = `0x${"00".repeat(32)}` as `0x${string}`;
        expect(hexToBytes(hex).length).toBe(32);
    });

    it("round-trips with bytesToPrefixedHex", () => {
        const original = new Uint8Array(32);
        for (let i = 0; i < 32; i++) {
            original[i] = i;
        }
        const hex = bytesToPrefixedHex(original);
        expect(hexToBytes(hex)).toEqual(original);
    });
});

describe("bytesToPrefixedHex", () => {
    it("produces a 0x-prefixed hex string", () => {
        const bytes = new Uint8Array(32);
        const hex = bytesToPrefixedHex(bytes);
        expect(hex.startsWith("0x")).toBe(true);
        expect(hex.length).toBe(66); // "0x" + 64 hex chars
    });

    it("round-trips with hexToBytes for arbitrary bytes", () => {
        const original = new Uint8Array(32);
        for (let i = 0; i < 32; i++) {
            original[i] = (i * 7 + 3) % 256;
        }
        const hex = bytesToPrefixedHex(original);
        expect(hexToBytes(hex)).toEqual(original);
    });
});

describe("sha256Hex", () => {
    it('produces the standard SHA-256 vector for "abc"', async () => {
        const input = new TextEncoder().encode("abc");
        const result = await sha256Hex(input);
        expect(result).toBe("0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });
});

describe("sha256Bytes", () => {
    it("returns 32 bytes for arbitrary input", async () => {
        const result = await sha256Bytes(new Uint8Array(0));
        expect(result.length).toBe(32);
    });

    it("matches sha256Hex output", async () => {
        const input = new TextEncoder().encode("hello");
        const bytes = await sha256Bytes(input);
        const hex = await sha256Hex(input);
        expect(bytesToPrefixedHex(bytes)).toBe(hex);
    });
});
