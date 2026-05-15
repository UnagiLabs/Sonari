# USGS pending_mmi_empty_grid

Source:
- Derived from USGS event: us7000pending-mmi
- Captured at: 2026-05-15
- Modified for fixture: yes
- Network access required for tests: no

This artificial fixture represents a USGS detail response with a ShakeMap source and a fetched grid, but the grid has no usable MMI values. The Oracle must not finalize and should return `pending_mmi` with `MMI_NOT_AVAILABLE`.

The USGS detail JSON is minimized to the fields needed by Oracle workflow tests.
