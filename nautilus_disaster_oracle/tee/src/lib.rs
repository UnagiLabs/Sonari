#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_bcs_numeric_enums_to_typescript_contract() {
        assert_eq!(INTENT_SONARI_EARTHQUAKE_ORACLE, 1);
        assert_eq!(HAZARD_TYPE_EARTHQUAKE, 1);
        assert_eq!(ONCHAIN_STATUS_FINALIZED, 3);
        assert_eq!(PRIMARY_SOURCE_USGS, 1);
        assert_eq!(CELLS_GENERATION_METHOD_SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1, 1);
        assert_eq!(CELL_METRIC_USGS_MMI, 1);
        assert_eq!(CELL_AGGREGATION_GRID_POINT_P90, 1);
        assert_eq!(INTENSITY_SCALE_MMI_X100, 1);
    }

    #[test]
    fn pins_mvp_default_contract_values() {
        assert_eq!(ORACLE_VERSION, 1);
        assert_eq!(GEO_RESOLUTION, 7);
        assert_eq!(MIN_CLAIM_BAND, 1);
    }
}
