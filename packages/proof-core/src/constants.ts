/**
 * Domain separators for the Sonari proof hashing scheme.
 *
 * leaf_hash      = SHA-256(0x00 || leaf_bytes)
 * internal_hash  = SHA-256(0x01 || left_32 || right_32)
 *
 * These prefixes keep leaf hashes and internal node hashes from colliding,
 * and match the Rust (`data/residence_cells`), Move (`affected_cell.move`),
 * and Python (`schemas/examples/verify_golden_vectors.py`) implementations.
 */
export const LEAF_HASH_DOMAIN_SEPARATOR = 0x00;
export const INTERNAL_NODE_DOMAIN_SEPARATOR = 0x01;
