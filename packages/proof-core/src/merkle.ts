import type { PrefixedHex32 } from "./bytes.js";
import { bytesToPrefixedHex, hexToBytes, sha256Bytes } from "./bytes.js";
import { INTERNAL_NODE_DOMAIN_SEPARATOR } from "./constants.js";
import { expectPrefixedHex32 } from "./schema.js";

export interface ProofStep {
    sibling_on_left: boolean;
    sibling_hash: PrefixedHex32;
}

export function replayProof(leafHashValue: string, proof: readonly ProofStep[]): PrefixedHex32 {
    let current = hexToBytes(expectPrefixedHex32("leaf_hash", leafHashValue));
    for (const step of proof) {
        const sibling = hexToBytes(expectPrefixedHex32("sibling_hash", step.sibling_hash));
        const input = new Uint8Array(65);
        input[0] = INTERNAL_NODE_DOMAIN_SEPARATOR;
        if (step.sibling_on_left) {
            input.set(sibling, 1);
            input.set(current, 33);
        } else {
            input.set(current, 1);
            input.set(sibling, 33);
        }
        current = sha256Bytes(input);
    }
    return bytesToPrefixedHex(current);
}

function internalHash(left: PrefixedHex32, right: PrefixedHex32): PrefixedHex32 {
    const leftBytes = hexToBytes(left);
    const rightBytes = hexToBytes(right);
    const input = new Uint8Array(65);
    input[0] = INTERNAL_NODE_DOMAIN_SEPARATOR;
    input.set(leftBytes, 1);
    input.set(rightBytes, 33);
    return bytesToPrefixedHex(sha256Bytes(input));
}

export function merkleLevelsFromLeafHashes(leafHashes: PrefixedHex32[]): PrefixedHex32[][] {
    if (leafHashes.length === 0) {
        throw new Error("empty Merkle tree");
    }
    const levels: PrefixedHex32[][] = [leafHashes];
    let current: PrefixedHex32[] = leafHashes;
    while (current.length > 1) {
        const next: PrefixedHex32[] = [];
        for (let i = 0; i < current.length; i += 2) {
            if (i + 1 === current.length) {
                // odd tail: promote without hashing
                const tail = current[i];
                if (tail === undefined) throw new Error("unexpected undefined at index");
                next.push(tail);
            } else {
                const left = current[i];
                const right = current[i + 1];
                if (left === undefined || right === undefined)
                    throw new Error("unexpected undefined in pair");
                next.push(internalHash(left, right));
            }
        }
        levels.push(next);
        current = next;
    }
    return levels;
}

export function merkleRootFromLeafHashes(leafHashes: PrefixedHex32[]): PrefixedHex32 {
    const levels = merkleLevelsFromLeafHashes(leafHashes);
    const rootLevel = levels[levels.length - 1];
    if (rootLevel === undefined || rootLevel[0] === undefined) {
        throw new Error("unexpected empty root level");
    }
    return rootLevel[0];
}

export function proofStepsFromLevels(levels: PrefixedHex32[][], leafIndex: number): ProofStep[] {
    const leafLevel = levels[0];
    if (leafLevel === undefined) {
        throw new Error("levels array is empty");
    }
    if (leafIndex < 0 || leafIndex >= leafLevel.length) {
        throw new Error(
            `leafIndex ${leafIndex} is out of range for tree with ${leafLevel.length} leaves`,
        );
    }
    const steps: ProofStep[] = [];
    let index = leafIndex;
    for (let level = 0; level < levels.length - 1; level++) {
        const current = levels[level];
        if (current === undefined) throw new Error(`unexpected undefined level ${level}`);
        const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
        if (siblingIndex < current.length) {
            const siblingHash = current[siblingIndex];
            if (siblingHash === undefined) throw new Error("unexpected undefined sibling");
            steps.push({
                sibling_on_left: siblingIndex < index,
                sibling_hash: siblingHash,
            });
        }
        // if siblingIndex >= current.length, the node was an odd tail (promoted), no step
        index = Math.floor(index / 2);
    }
    return steps;
}
