# USGS rejected_cancelled_shakemap

Source:
- Derived from USGS event: us7000cancelled
- Captured at: 2026-05-15
- Modified for fixture: yes
- Network access required for tests: no

This artificial fixture represents a USGS ShakeMap product whose `map-status` is `CANCELLED`. The Oracle must reject without reading a grid and should return `SHAKEMAP_CANCELLED`.

The USGS detail JSON is minimized to the fields needed by Oracle workflow tests.
