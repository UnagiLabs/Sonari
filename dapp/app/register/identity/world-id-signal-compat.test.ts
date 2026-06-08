/**
 * IDKit hashSignal compatibility golden test.
 *
 * This test is the primary regression guard for the World ID signal_hash
 * binding between the dapp and the enclave. If this test breaks, IDKit's
 * hashing no longer matches proof-core's computation, which would cause every
 * World ID proof to fail on-chain.
 *
 * Assertions:
 *   1. hashSignal(worldIdSignalString(o, m, s)) equals
 *      await computeWorldIdSignalHash(o, m, s) — IDKit and proof-core agree.
 *   2. The result matches the known fixture value from
 *      world-id-signal-hash-vectors.json — prevents silent drift.
 */
import { hashSignal } from "@worldcoin/idkit/hashing";
import { computeWorldIdSignalHash, worldIdSignalString } from "@sonari/proof-core";
import { describe, expect, it } from "vitest";

// Fixture values from
// packages/proof-core/src/fixtures/world-id-signal-hash-vectors.json
// "name": "owner 33 membership 22 statement 66"
const OWNER = "0x3333333333333333333333333333333333333333333333333333333333333333";
const MEMBERSHIP_ID = "0x2222222222222222222222222222222222222222222222222222222222222222";
const SIGNED_STATEMENT_HASH =
    "0x6666666666666666666666666666666666666666666666666666666666666666";
const EXPECTED_SIGNAL_HASH =
    "0x004c584cd5e136507a762e7bc3bdd3f2e2535f5d32a7c6f343e17377886cca47";

describe("IDKit hashSignal compat (golden test)", () => {
    it("hashSignal(worldIdSignalString) matches computeWorldIdSignalHash", async () => {
        const signal = worldIdSignalString(OWNER, MEMBERSHIP_ID, SIGNED_STATEMENT_HASH);
        const idkitHash = hashSignal(signal);
        const proofCoreHash = await computeWorldIdSignalHash(
            OWNER,
            MEMBERSHIP_ID,
            SIGNED_STATEMENT_HASH,
        );

        expect(idkitHash).toBe(proofCoreHash);
    });

    it("hashSignal result matches the fixture expected_signal_hash", () => {
        const signal = worldIdSignalString(OWNER, MEMBERSHIP_ID, SIGNED_STATEMENT_HASH);
        const idkitHash = hashSignal(signal);

        expect(idkitHash).toBe(EXPECTED_SIGNAL_HASH);
    });

    it("computeWorldIdSignalHash result matches the fixture expected_signal_hash", async () => {
        const hash = await computeWorldIdSignalHash(OWNER, MEMBERSHIP_ID, SIGNED_STATEMENT_HASH);

        expect(hash).toBe(EXPECTED_SIGNAL_HASH);
    });
});
