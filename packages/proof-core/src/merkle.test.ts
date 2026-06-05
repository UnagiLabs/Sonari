import { describe, expect, it } from "vitest";
import { type ProofStep, replayProof } from "./merkle.js";

// Golden vector from schemas/examples/sample_proof.json
// direction: "LEFT" => sibling_on_left: true
const GOLDEN_LEAF_HASH = "0xbc6630b4dcc0a7aab256c84b90d30d6d8eefbf6b8712767917ccbe6c603a303f";
const GOLDEN_SIBLING = "0x83bc299c544edc5bff30176c8840ae2b3c001f8a10ea28c158761a5793c79b2f";
const GOLDEN_ROOT = "0x526e982479c985a009227facabf22c6d7633110fb1a15a743b453218f7f1890f";

// Three-leaf tree from the worker test fixtures (Rust-matched golden vectors)
const LEAF_ONE_HASH = "0x07985a56b782bd13b8ec079d4c243c8c2399605872223fc86066f59f4ae37569";
const LEAF_TWO_HASH = "0xfa0172aedc1751590d58bd2c91d8e37aca3b9c4b4a330c7330440b5203806c4e";
const LEAF_THREE_HASH = "0x8f8a501ba455071229e715f5eccb4322190440fa2ecb6b72d123378648b60ec7";
const MERKLE_ROOT = "0xa26a12dc49754fde5b90e6bff69d1bc8b51fb8a3de07aa9122a9a2958bb75020";

const LEAF_ONE_PROOF: readonly ProofStep[] = [
    {
        sibling_on_left: false,
        sibling_hash: "0xfa0172aedc1751590d58bd2c91d8e37aca3b9c4b4a330c7330440b5203806c4e",
    },
    {
        sibling_on_left: false,
        sibling_hash: "0x8f8a501ba455071229e715f5eccb4322190440fa2ecb6b72d123378648b60ec7",
    },
];

const LEAF_TWO_PROOF: readonly ProofStep[] = [
    {
        sibling_on_left: true,
        sibling_hash: "0x07985a56b782bd13b8ec079d4c243c8c2399605872223fc86066f59f4ae37569",
    },
    {
        sibling_on_left: false,
        sibling_hash: "0x8f8a501ba455071229e715f5eccb4322190440fa2ecb6b72d123378648b60ec7",
    },
];

const LEAF_THREE_PROOF: readonly ProofStep[] = [
    {
        sibling_on_left: true,
        sibling_hash: "0x312e3863ccf00e446423342e1acebdab8e7119ee19dae854904de693225c2678",
    },
];

describe("replayProof", () => {
    it("replays 1-step proof using the sample_proof.json golden vector", async () => {
        const step: ProofStep = {
            sibling_on_left: true,
            sibling_hash: GOLDEN_SIBLING,
        };
        const root = await replayProof(GOLDEN_LEAF_HASH, [step]);
        expect(root).toBe(GOLDEN_ROOT);
    });

    it("returns leaf hash when proof is empty", async () => {
        const result = await replayProof(LEAF_ONE_HASH, []);
        expect(result).toBe(LEAF_ONE_HASH);
    });

    it("replays multi-step proofs consistent with Rust golden vectors (leaf one)", async () => {
        expect(await replayProof(LEAF_ONE_HASH, LEAF_ONE_PROOF)).toBe(MERKLE_ROOT);
    });

    it("replays multi-step proofs consistent with Rust golden vectors (leaf two)", async () => {
        expect(await replayProof(LEAF_TWO_HASH, LEAF_TWO_PROOF)).toBe(MERKLE_ROOT);
    });

    it("replays multi-step proofs consistent with Rust golden vectors (leaf three)", async () => {
        expect(await replayProof(LEAF_THREE_HASH, LEAF_THREE_PROOF)).toBe(MERKLE_ROOT);
    });

    it("throws for invalid leaf hash format", async () => {
        await expect(replayProof("not-a-hash", [])).rejects.toThrow(
            /must be a lowercase 0x-prefixed 32-byte hex string/,
        );
    });

    it("throws for invalid sibling hash format", async () => {
        const badStep: ProofStep = {
            sibling_on_left: false,
            sibling_hash: "0xinvalid" as `0x${string}`,
        };
        await expect(replayProof(LEAF_ONE_HASH, [badStep])).rejects.toThrow(
            /must be a lowercase 0x-prefixed 32-byte hex string/,
        );
    });
});
