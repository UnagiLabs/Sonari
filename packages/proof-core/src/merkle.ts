import type { PrefixedHex32 } from "./bytes.js";
import { bytesToPrefixedHex, hexToBytes, sha256Bytes } from "./bytes.js";
import { INTERNAL_NODE_DOMAIN_SEPARATOR } from "./constants.js";
import { expectPrefixedHex32 } from "./schema.js";

export interface ProofStep {
    sibling_on_left: boolean;
    sibling_hash: PrefixedHex32;
}

export async function replayProof(
    leafHashValue: string,
    proof: readonly ProofStep[],
): Promise<PrefixedHex32> {
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
        current = await sha256Bytes(input);
    }
    return bytesToPrefixedHex(current);
}
