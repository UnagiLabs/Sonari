import { type PrefixedHex32, sha256Hex } from "./bytes.js";
import { LEAF_HASH_DOMAIN_SEPARATOR } from "./constants.js";

export function hashLeafBytes(leafBytes: Uint8Array): PrefixedHex32 {
    const prefixed = new Uint8Array(1 + leafBytes.length);
    prefixed[0] = LEAF_HASH_DOMAIN_SEPARATOR;
    prefixed.set(leafBytes, 1);
    return sha256Hex(prefixed);
}
