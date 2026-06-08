import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    computeWorldIdSignalHash,
    hashToFieldBytes,
    WORLD_ID_SIGNAL_HASH_PREFIX,
} from "./world-id-signal.js";

const OWNER = `0x${"33".repeat(32)}`;
const MEMBERSHIP_ID = `0x${"22".repeat(32)}`;
const SIGNED_STATEMENT_HASH = `0x${"66".repeat(32)}`;
const GOLDEN_VECTORS = readGoldenVectors();

describe("computeWorldIdSignalHash", () => {
    it("exposes the enclave-bound domain prefix", () => {
        expect(WORLD_ID_SIGNAL_HASH_PREFIX).toBe("sonari:world_id_signal:v1");
    });

    it("matches the official World ID hash_to_field vectors", () => {
        for (const vector of GOLDEN_VECTORS.official_hash_to_field) {
            const inputBytes = hexBytes(vector.input_bytes_hex);
            if (vector.input_utf8 !== null) {
                expect(bytesToHex(new TextEncoder().encode(vector.input_utf8))).toBe(
                    vector.input_bytes_hex,
                );
            }

            expect(hashToFieldBytes(inputBytes), vector.name).toBe(vector.expected_hash_to_field);
        }
    });

    it("matches the enclave fixed-formula golden vector", async () => {
        // Golden vector locked by the enclave test
        // `world_id_signal_hash_matches_fixed_formula`
        // (nautilus/verifiers/membership/tee/src/core/processing.rs). If this
        // assertion fails the dapp would derive a signal_hash the enclave rejects.
        await expect(
            computeWorldIdSignalHash(
                GOLDEN_VECTORS.sonari_signal_hash.owner,
                GOLDEN_VECTORS.sonari_signal_hash.membership_id,
                GOLDEN_VECTORS.sonari_signal_hash.signed_statement_hash,
            ),
        ).resolves.toBe(GOLDEN_VECTORS.sonari_signal_hash.expected_signal_hash);
    });

    it("normalizes uppercase hex to the same digest as lowercase", async () => {
        const lower = `0x${"ab".repeat(32)}`;
        const upper = `0X${"AB".repeat(32)}`;
        const fromLower = await computeWorldIdSignalHash(
            lower,
            MEMBERSHIP_ID,
            SIGNED_STATEMENT_HASH,
        );
        const fromUpper = await computeWorldIdSignalHash(
            upper,
            MEMBERSHIP_ID,
            SIGNED_STATEMENT_HASH,
        );

        expect(fromUpper).toBe(fromLower);
    });

    it("returns a 0x-prefixed 32-byte hex string", async () => {
        const signalHash = await computeWorldIdSignalHash(
            OWNER,
            MEMBERSHIP_ID,
            SIGNED_STATEMENT_HASH,
        );

        expect(signalHash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(signalHash.startsWith("0x00")).toBe(true);
    });

    it("rejects inputs without a 0x prefix", async () => {
        await expect(
            computeWorldIdSignalHash("33".repeat(32), MEMBERSHIP_ID, SIGNED_STATEMENT_HASH),
        ).rejects.toThrow("owner must be a 0x-prefixed 32-byte hex string");
    });

    it("rejects inputs that are too short", async () => {
        await expect(
            computeWorldIdSignalHash(OWNER, "0x33", SIGNED_STATEMENT_HASH),
        ).rejects.toThrow("membership_id must be a 0x-prefixed 32-byte hex string");
    });

    it("rejects inputs that are too long", async () => {
        await expect(
            computeWorldIdSignalHash(OWNER, MEMBERSHIP_ID, `0x${"66".repeat(33)}`),
        ).rejects.toThrow("signed_statement_hash must be a 0x-prefixed 32-byte hex string");
    });

    it("rejects non-hex characters", async () => {
        await expect(
            computeWorldIdSignalHash(`0x${"zz".repeat(32)}`, MEMBERSHIP_ID, SIGNED_STATEMENT_HASH),
        ).rejects.toThrow("owner must be a 0x-prefixed 32-byte hex string");
    });

    it("rejects empty inputs", async () => {
        await expect(computeWorldIdSignalHash(OWNER, MEMBERSHIP_ID, "")).rejects.toThrow(
            "signed_statement_hash must be a 0x-prefixed 32-byte hex string",
        );
    });
});

interface GoldenVectors {
    readonly official_hash_to_field: readonly OfficialHashToFieldVector[];
    readonly sonari_signal_hash: SonariSignalHashVector;
}

interface OfficialHashToFieldVector {
    readonly name: string;
    readonly input_utf8: string | null;
    readonly input_bytes_hex: `0x${string}`;
    readonly expected_hash_to_field: `0x${string}`;
}

interface SonariSignalHashVector {
    readonly owner: `0x${string}`;
    readonly membership_id: `0x${string}`;
    readonly signed_statement_hash: `0x${string}`;
    readonly expected_signal_hash: `0x${string}`;
}

function readGoldenVectors(): GoldenVectors {
    const raw = readFileSync(
        new URL("./fixtures/world-id-signal-hash-vectors.json", import.meta.url),
        "utf8",
    );
    const parsed: unknown = JSON.parse(raw);
    if (!isGoldenVectors(parsed)) {
        throw new Error("world-id signal hash golden vectors are malformed");
    }
    return parsed;
}

function isGoldenVectors(value: unknown): value is GoldenVectors {
    if (!isRecord(value) || !Array.isArray(value.official_hash_to_field)) {
        return false;
    }
    if (!value.official_hash_to_field.every(isOfficialHashToFieldVector)) {
        return false;
    }
    return isSonariSignalHashVector(value.sonari_signal_hash);
}

function isOfficialHashToFieldVector(value: unknown): value is OfficialHashToFieldVector {
    if (!isRecord(value)) {
        return false;
    }
    return (
        typeof value.name === "string" &&
        (typeof value.input_utf8 === "string" || value.input_utf8 === null) &&
        isPrefixedHex(value.input_bytes_hex) &&
        isPrefixedHex(value.expected_hash_to_field)
    );
}

function isSonariSignalHashVector(value: unknown): value is SonariSignalHashVector {
    if (!isRecord(value)) {
        return false;
    }
    return (
        isPrefixedHex(value.owner) &&
        isPrefixedHex(value.membership_id) &&
        isPrefixedHex(value.signed_statement_hash) &&
        isPrefixedHex(value.expected_signal_hash)
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isPrefixedHex(value: unknown): value is `0x${string}` {
    return typeof value === "string" && /^0x[0-9a-f]*$/.test(value);
}

function hexBytes(value: `0x${string}`): Uint8Array {
    const hex = value.slice(2);
    if (hex.length % 2 !== 0) {
        throw new Error("hex byte string must have even length");
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
}

function bytesToHex(bytes: Uint8Array): `0x${string}` {
    return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
