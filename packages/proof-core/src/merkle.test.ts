import { describe, expect, it } from "vitest";
import {
    merkleLevelsFromLeafHashes,
    merkleRootFromLeafHashes,
    type ProofStep,
    proofStepsFromLevels,
    replayProof,
} from "./merkle.js";

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
    it("replays 1-step proof using the sample_proof.json golden vector", () => {
        const step: ProofStep = {
            sibling_on_left: true,
            sibling_hash: GOLDEN_SIBLING,
        };
        const root = replayProof(GOLDEN_LEAF_HASH, [step]);
        expect(root).toBe(GOLDEN_ROOT);
    });

    it("returns leaf hash when proof is empty", () => {
        const result = replayProof(LEAF_ONE_HASH, []);
        expect(result).toBe(LEAF_ONE_HASH);
    });

    it("replays multi-step proofs consistent with Rust golden vectors (leaf one)", () => {
        expect(replayProof(LEAF_ONE_HASH, LEAF_ONE_PROOF)).toBe(MERKLE_ROOT);
    });

    it("replays multi-step proofs consistent with Rust golden vectors (leaf two)", () => {
        expect(replayProof(LEAF_TWO_HASH, LEAF_TWO_PROOF)).toBe(MERKLE_ROOT);
    });

    it("replays multi-step proofs consistent with Rust golden vectors (leaf three)", () => {
        expect(replayProof(LEAF_THREE_HASH, LEAF_THREE_PROOF)).toBe(MERKLE_ROOT);
    });

    it("throws for invalid leaf hash format", () => {
        expect(() => replayProof("not-a-hash", [])).toThrow(
            /must be a lowercase 0x-prefixed 32-byte hex string/,
        );
    });

    it("throws for invalid sibling hash format", () => {
        const badStep: ProofStep = {
            sibling_on_left: false,
            sibling_hash: "0xinvalid" as `0x${string}`,
        };
        expect(() => replayProof(LEAF_ONE_HASH, [badStep])).toThrow(
            /must be a lowercase 0x-prefixed 32-byte hex string/,
        );
    });
});

// ---------------------------------------------------------------------------
// STEP 4: Merkle generation (merkleLevelsFromLeafHashes / merkleRootFromLeafHashes / proofStepsFromLevels)
// ---------------------------------------------------------------------------

describe("merkleRootFromLeafHashes", () => {
    it("returns the correct golden root for 2-leaf tree (expected_hashes.json)", () => {
        // leaf_hashes array order from expected_hashes.json
        const leafHashes = [
            "0x83bc299c544edc5bff30176c8840ae2b3c001f8a10ea28c158761a5793c79b2f" as const,
            "0xbc6630b4dcc0a7aab256c84b90d30d6d8eefbf6b8712767917ccbe6c603a303f" as const,
        ];
        const root = merkleRootFromLeafHashes(leafHashes);
        expect(root).toBe(GOLDEN_ROOT);
    });

    it("returns the single leaf as root for a 1-leaf tree", () => {
        const root = merkleRootFromLeafHashes([GOLDEN_LEAF_HASH]);
        expect(root).toBe(GOLDEN_LEAF_HASH);
    });

    it("throws for empty leaf array", () => {
        expect(() => merkleRootFromLeafHashes([])).toThrow(/empty Merkle tree/);
    });
});

describe("proofStepsFromLevels (2-leaf golden)", () => {
    it("returns a single sibling_on_left step for index 1 matching sample_proof.json", () => {
        const leafHashes = [
            "0x83bc299c544edc5bff30176c8840ae2b3c001f8a10ea28c158761a5793c79b2f" as const,
            "0xbc6630b4dcc0a7aab256c84b90d30d6d8eefbf6b8712767917ccbe6c603a303f" as const,
        ];
        const levels = merkleLevelsFromLeafHashes(leafHashes);
        const steps = proofStepsFromLevels(levels, 1);
        expect(steps).toHaveLength(1);
        expect(steps[0]).toEqual({
            sibling_on_left: true,
            sibling_hash: "0x83bc299c544edc5bff30176c8840ae2b3c001f8a10ea28c158761a5793c79b2f",
        });
    });

    it("returns a single sibling_on_right step for index 0", () => {
        const leafHashes = [
            "0x83bc299c544edc5bff30176c8840ae2b3c001f8a10ea28c158761a5793c79b2f" as const,
            "0xbc6630b4dcc0a7aab256c84b90d30d6d8eefbf6b8712767917ccbe6c603a303f" as const,
        ];
        const levels = merkleLevelsFromLeafHashes(leafHashes);
        const steps = proofStepsFromLevels(levels, 0);
        expect(steps).toHaveLength(1);
        expect(steps[0]).toEqual({
            sibling_on_left: false,
            sibling_hash: "0xbc6630b4dcc0a7aab256c84b90d30d6d8eefbf6b8712767917ccbe6c603a303f",
        });
    });

    it("throws for out-of-range leafIndex", () => {
        const leafHashes = [
            "0x83bc299c544edc5bff30176c8840ae2b3c001f8a10ea28c158761a5793c79b2f" as const,
        ];
        const levels = merkleLevelsFromLeafHashes(leafHashes);
        expect(() => proofStepsFromLevels(levels, -1)).toThrow();
        expect(() => proofStepsFromLevels(levels, 1)).toThrow();
    });
});

describe("generation <-> verification closure (2-leaf)", () => {
    it("replayProof on generated proof reproduces root for both indices", () => {
        const leafHashes: import("./bytes.js").PrefixedHex32[] = [
            "0x83bc299c544edc5bff30176c8840ae2b3c001f8a10ea28c158761a5793c79b2f",
            "0xbc6630b4dcc0a7aab256c84b90d30d6d8eefbf6b8712767917ccbe6c603a303f",
        ];
        const levels = merkleLevelsFromLeafHashes(leafHashes);
        const root = merkleRootFromLeafHashes(leafHashes);
        for (const leaf of leafHashes) {
            const i = leafHashes.indexOf(leaf);
            const steps = proofStepsFromLevels(levels, i);
            const replayed = replayProof(leaf, steps);
            expect(replayed).toBe(root);
        }
    });
});

describe("generation <-> verification closure (1-leaf)", () => {
    it("replayProof on empty proof returns the single leaf as root", () => {
        const leafHashes: import("./bytes.js").PrefixedHex32[] = [GOLDEN_LEAF_HASH];
        const levels = merkleLevelsFromLeafHashes(leafHashes);
        const root = merkleRootFromLeafHashes(leafHashes);
        const steps = proofStepsFromLevels(levels, 0);
        expect(steps).toHaveLength(0);
        const replayed = replayProof(GOLDEN_LEAF_HASH, steps);
        expect(replayed).toBe(root);
    });
});

describe("generation <-> verification closure (3-leaf, odd promotion)", () => {
    // Use the three-leaf golden hashes already defined at the top
    const THREE_LEAVES: import("./bytes.js").PrefixedHex32[] = [
        LEAF_ONE_HASH,
        LEAF_TWO_HASH,
        LEAF_THREE_HASH,
    ];

    it("merkleRootFromLeafHashes matches the Rust golden root", () => {
        const root = merkleRootFromLeafHashes(THREE_LEAVES);
        expect(root).toBe(MERKLE_ROOT);
    });

    it("replayProof reproduces root for all three indices", () => {
        const levels = merkleLevelsFromLeafHashes(THREE_LEAVES);
        const root = merkleRootFromLeafHashes(THREE_LEAVES);
        for (const leaf of THREE_LEAVES) {
            const i = THREE_LEAVES.indexOf(leaf);
            const steps = proofStepsFromLevels(levels, i);
            const replayed = replayProof(leaf, steps);
            expect(replayed).toBe(root);
        }
    });

    it("index 2 (odd tail) has no level-0 step (promoted without hashing)", () => {
        const levels = merkleLevelsFromLeafHashes(THREE_LEAVES);
        const steps = proofStepsFromLevels(levels, 2);
        // level 0 has 3 nodes: index 2 is the lone tail (odd), so no sibling at level 0
        // the proof ascends directly from level 1
        expect(steps).toHaveLength(1);
        // At level 1: index 2 was promoted to index 1 (floor(2/2)=1), its sibling is index 0 (the pair hash of leaves 0,1)
        const step0 = steps[0];
        if (step0 === undefined) throw new Error("expected step at index 0");
        expect(step0.sibling_on_left).toBe(true);
    });
});
