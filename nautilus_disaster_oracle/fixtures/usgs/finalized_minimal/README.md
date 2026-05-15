# USGS finalized_minimal

Source:
- Derived from USGS event: us7000sonari
- Captured at: 2026-05-15
- Modified for fixture: yes
- Network access required for tests: no

This fixture is derived from the root `schemas/examples/` 2-point ShakeMap golden. The USGS detail JSON is minimized to the fields needed by Oracle workflow tests.

Step 2 fixture uses plain `input/usgs_grid.xml` as raw source bytes for deterministic testing. This is separate from the future production `grid.xml.zip` byte hashing contract.

## Manual Check Table

| grid point | latitude | longitude | MMI | H3 index | P90 input values | P90 result | cell_band |
| ---: | ---: | ---: | ---: | --- | --- | ---: | ---: |
| 1 | 35.6000 | 139.7000 | 7.23 | 608692970719281151 | [723] | 723 | 1 |
| 2 | 35.6100 | 139.7100 | 8.31 | 608692970719543295 | [831] | 831 | 2 |

P90 definition:
1. Sort intensity values in the cell in ascending order.
2. `rank = ceil(0.90 * n) - 1`.
3. `values[rank]` is the P90 result.

Future fixture:
- `finalized_multi_point_same_cell`
- Add multiple grid points to one H3 cell to verify `GRID_POINT_P90` implementation.
