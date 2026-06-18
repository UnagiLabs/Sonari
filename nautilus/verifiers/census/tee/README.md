# Census TEE

`census-tee` is the Rust crate for the Sonari floor census verifier.

## Responsibility

- Validate the affected-cells artifact against the signed earthquake result.
- Resolve the census checkpoint as the latest Sui checkpoint at or before the
  disaster occurrence time.
- Resolve `CellCountIndex` and needed `CellCountShard` objects from on-chain
  GraphQL event metadata.
- Read H3 res7 cell counts from GraphQL `atCheckpoint` state.
- Compute `registered_members_by_band` and `counted_cells_root`.
- BCS-encode and sign `FloorCensusResult`.

The production input includes event context, `package_id`, `membership_registry_id`,
and `affected_cells`. It does not accept replayed membership events,
`active_lineages`, caller-supplied `counted_cells`, or caller-supplied
`counted_cells_root`.

## Out of Scope

- Move contract changes.
- Membership registration updates.
- Contract submission; the runner submits the signed output.
