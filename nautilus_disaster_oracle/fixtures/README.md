# Nautilus Disaster Oracle Fixtures

These fixtures pin Oracle workflow inputs and expected results before the Rust Oracle Core is implemented.

`schemas/examples/` remains the cross-language golden contract for root schemas, BCS, hashes, Merkle leaves, and manifests. This directory is the Oracle scenario fixture layer used by future Core, Watcher, and Relayer tests.

Tests must not access USGS or any other network source. All verification reads only files stored in this directory.

Step 2 fixture uses plain `input/usgs_grid.xml` as raw source bytes for deterministic testing. This is separate from the future production `grid.xml.zip` byte hashing contract.

Hash algorithm:
- `raw_data_hash`: `SHA3-256(input/usgs_grid.xml raw bytes)`
- `source_set_hash`: `SHA3-256(canonical source_manifest.json bytes)`
- `affected_cells_data_hash`: `SHA3-256(canonical affected_cells.json bytes)`
- Merkle leaf and internal node hashes: `SHA3-256`

Run:

```bash
python3 nautilus_disaster_oracle/fixtures/verify_fixtures.py
```
