# USGS pending_source_no_shakemap

Source:
- Derived from USGS event: us7000pending-source
- Captured at: 2026-05-15
- Modified for fixture: yes
- Network access required for tests: no

This artificial fixture represents a USGS detail response that was fetched successfully, but `products.shakemap` is absent. The Oracle must not finalize and should return `pending_source` with `SHAKEMAP_PRODUCT_MISSING`.

The USGS detail JSON is minimized to the fields needed by Oracle workflow tests.
