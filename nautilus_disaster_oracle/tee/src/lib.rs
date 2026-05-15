pub const INTENT_SONARI_EARTHQUAKE_ORACLE: u8 = 1;
pub const HAZARD_TYPE_EARTHQUAKE: u8 = 1;
pub const ONCHAIN_STATUS_FINALIZED: u8 = 3;
pub const PRIMARY_SOURCE_USGS: u8 = 1;
pub const CELLS_GENERATION_METHOD_SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1: u8 = 1;
pub const CELLS_GENERATION_METHOD_SHAKEMAP_HDF_H3_WEIGHTED_P90_V1: u8 = 2;
pub const CELLS_GENERATION_METHOD_JMA_250M_H3_P90_V1: u8 = 3;
pub const CELL_METRIC_USGS_MMI: u8 = 1;
pub const CELL_METRIC_JMA_SHINDO: u8 = 2;
pub const CELL_AGGREGATION_GRID_POINT_P90: u8 = 1;
pub const INTENSITY_SCALE_MMI_X100: u8 = 1;
pub const INTENSITY_SCALE_JMA_SHINDO_X10: u8 = 2;

pub const ORACLE_VERSION: u64 = 1;
pub const GEO_RESOLUTION: u8 = 7;
pub const MIN_CLAIM_BAND: u8 = 1;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_bcs_numeric_enums_to_typescript_contract() {
        assert_eq!(INTENT_SONARI_EARTHQUAKE_ORACLE, 1);
        assert_eq!(HAZARD_TYPE_EARTHQUAKE, 1);
        assert_eq!(ONCHAIN_STATUS_FINALIZED, 3);
        assert_eq!(PRIMARY_SOURCE_USGS, 1);
        assert_eq!(
            CELLS_GENERATION_METHOD_SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1,
            1
        );
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
