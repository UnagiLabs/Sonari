# FloorCensusResult BCS contract

This document fixes the BCS bytes signed by the Floor Census verifier.
The Sui contract trusts only these signed bytes and the verifier public key.
Relayers, UI code, and external APIs must not reinterpret the payload.

## Scope

`FloorCensusResult` is the result produced by the Floor Census TEE after
tallying registered members per affected-cell band for a given disaster event.
The result covers a single event revision and carries the affected-cells root,
the membership count index, and the counted-cells root used during counting.

## Field order

BCS has no field names in the encoded bytes. The order below is therefore part
of the contract.

| Order | Field | BCS type | Meaning |
| --- | --- | --- | --- |
| 1 | `intent` | `vector<u8>` | ASCII `SONARI_FLOOR_CENSUS_V1` |
| 2 | `verifier_family` | `vector<u8>` | ASCII `census` |
| 3 | `verifier_version` | `u64` | Version `1` |
| 4 | `event_uid` | 32 raw bytes | Disaster event object id (no BCS length prefix) |
| 5 | `event_revision` | `u32` | Revision of the disaster event at the time of census |
| 6 | `affected_cells_root` | 32 raw bytes | Merkle root of affected cells (no BCS length prefix) |
| 7 | `membership_registry_id` | 32 raw bytes | Membership registry object id used for the count |
| 8 | `cell_count_index_id` | 32 raw bytes | CellCountIndex object id used for shard count lookup |
| 9 | `census_checkpoint` | `u64` | Checkpoint at which cell counts were read |
| 10 | `h3_resolution` | `u8` | Fixed value `7` |
| 11 | `shard_count` | `u64` | Fixed value `4096` |
| 12 | `registered_members_by_band` | `vector<u64>` | ULEB128 length + exactly 3 × `u64` LE; band index matches distance band enum |
| 13 | `counted_cells_root` | 32 raw bytes | Merkle root of counted cell leaves computed by the TEE |
| 14 | `issued_at_ms` | `u64` | Census issue time in milliseconds since Unix epoch |

## Notes on raw-byte fields

Fields 4, 6, 7, 8, and 13 are serialised as exactly 32 raw bytes **without** a BCS
`vector<u8>` length prefix. This matches the `peel_bytes32` pattern used
throughout the Sonari contract suite (see `identity_result_v1.move`).

`counted_cells_root` uses the same tree rule as affected cells:

- leaf hash: `SHA-256(0x00 || BCS(CountedCellLeaf))`
- internal hash: `SHA-256(0x01 || left_32 || right_32)`
- odd leaf promotion does not duplicate the final hash
- leaves are sorted by numeric `h3_cell`

`CountedCellLeaf` field order:

1. `h3_cell: u64`
2. `cell_band: u8`
3. `shard_id: u64`
4. `count_at_census_checkpoint: u64`

## Census index invariants

`h3_resolution` must be `7`.
`shard_count` must be `4096`.
The Move contract aborts if either value differs.

## Band count invariant

`registered_members_by_band` must contain exactly `BAND_COUNT = 3` elements.
The Move contract aborts with `EInvalidBandCount` if the decoded length differs.

## Clock skew tolerance

An `issued_at_ms` value up to 300 seconds (300 000 ms) in the future relative
to the chain's `now_ms` is accepted to account for clock drift between the
enclave and the validator.

## Privacy

Golden vectors must not contain real disaster event IDs, real membership data,
or enclave secrets. Test values in this repository are deterministic fixtures only.
