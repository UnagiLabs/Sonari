# USGS rejected_no_affected_cells

Source:
- Derived from USGS event: us7000no-affected
- Captured at: 2026-05-15
- Modified for fixture: yes
- Network access required for tests: no

This artificial fixture represents a USGS ShakeMap source with valid MMI values, but all values are below MMI VII. The Oracle must reject because no `cell_band >= 1` affected cell exists.

The USGS detail JSON is minimized to the fields needed by Oracle workflow tests.
