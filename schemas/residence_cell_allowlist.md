# Residence Cell Allowlist Leaf

This schema defines the contract-facing leaf used to commit to residence cells that are eligible for registration. It is only the allowlist commitment format; full proof APIs and allowlist generation are owned by later steps.

## Canonical Field Order

Rust, TypeScript, Move, and independent schema checks must BCS serialize `ResidenceCellLeaf` in exactly this order:

| Order | Field | Type | Requirement |
| --: | --- | --- | --- |
| 1 | `h3_index` | `u64` | H3 index. JSON fixtures encode it as a decimal string. |
| 2 | `geo_resolution` | `u8` | MVP residence allowlist value is `7`. |
| 3 | `allowlist_version` | `u64` | Version of the residence allowlist commitment. |

## Leaf Hash

```txt
leaf_hash = SHA-256(0x00 || BCS(ResidenceCellLeaf))
```

The `0x00` prefix is a domain separator for leaves.

## Sort And Merkle Rules

- Sort leaves by numeric `h3_index` ascending before building the Merkle tree.
- Duplicate `h3_index` values are invalid for one allowlist version.
- Internal nodes use `internal_hash = SHA-256(0x01 || left_32 || right_32)`.
- The `0x01` prefix is a domain separator for internal nodes.
- If a Merkle level has an odd number of hashes, promote the final hash unchanged to the next level. Do not duplicate it.

## Proof Direction Mapping

Proof step `direction` is from the target hash's point of view:

- `LEFT` means the sibling is left of the current hash. It maps to Move `sibling_on_left = true`, and replay hashes `0x01 || sibling || current`.
- `RIGHT` means the sibling is right of the current hash. It maps to Move `sibling_on_left = false`, and replay hashes `0x01 || current || sibling`.

## Encoding Rules

- All integer fields use standard BCS little-endian encoding.
- JSON fixture `h3_index` values must be decimal strings.
- Leading zeroes are forbidden for `h3_index`, except the literal string `"0"`.
- `h3_index` must parse into `u64`.
