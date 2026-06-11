# FloorCensusResult BCS contract

This document fixes the BCS bytes signed by the Floor Census verifier.
The Sui contract trusts only these signed bytes and the verifier public key.
Relayers, UI code, and external APIs must not reinterpret the payload.

## Scope

`FloorCensusResult` is the result produced by the Floor Census TEE after
tallying registered members per affected-cell band for a given disaster event.
The result covers a single event revision and carries the affected-cells root
used during counting.

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
| 7 | `registered_members_by_band` | `vector<u64>` | ULEB128 length + exactly 3 × `u64` LE; band index matches distance band enum |
| 8 | `issued_at_ms` | `u64` | Census issue time in milliseconds since Unix epoch |

## Notes on raw-byte fields

Fields 4 and 6 are serialised as exactly 32 raw bytes **without** a BCS
`vector<u8>` length prefix. This matches the `peel_bytes32` pattern used
throughout the Sonari contract suite (see `identity_result_v1.move`).

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
