import { describe, expect, it } from "vitest";
import { computeWorldIdSignalHash, WORLD_ID_SIGNAL_HASH_PREFIX } from "./world-id-signal.js";

const OWNER = `0x${"33".repeat(32)}`;
const MEMBERSHIP_ID = `0x${"22".repeat(32)}`;
const SIGNED_STATEMENT_HASH = `0x${"66".repeat(32)}`;

describe("computeWorldIdSignalHash", () => {
    it("exposes the enclave-bound domain prefix", () => {
        expect(WORLD_ID_SIGNAL_HASH_PREFIX).toBe("sonari:world_id_signal:v1");
    });

    it("matches the enclave fixed-formula golden vector", async () => {
        // Golden vector locked by the enclave test
        // `world_id_signal_hash_matches_fixed_formula`
        // (nautilus/verifiers/membership/tee/src/core/processing.rs). If this
        // assertion fails the dapp would derive a signal_hash the enclave rejects.
        await expect(
            computeWorldIdSignalHash(OWNER, MEMBERSHIP_ID, SIGNED_STATEMENT_HASH),
        ).resolves.toBe("0x34b7cb40efe9b84ed3c26b036f2691f75c3bb1ecbfa695baf147a372aa2e3268");
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
