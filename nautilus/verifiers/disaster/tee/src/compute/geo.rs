use crate::MIN_CLAIM_BAND;
use crate::compute::intensity::{cell_band, p90_x100};
use crate::core::artifacts::AffectedCellJson;
use crate::core::types::OracleError;
use crate::source::usgs::GridPoint;
use h3o::{LatLng, Resolution};
use std::collections::BTreeMap;

pub(crate) fn affected_cells_from_points(
    points: &[GridPoint],
) -> Result<Vec<AffectedCellJson>, OracleError> {
    let mut grouped = BTreeMap::<u64, Vec<u16>>::new();
    for point in points {
        let lon = point.lon.parse::<f64>().map_err(|_| {
            OracleError::InvalidGridPoint(format!("invalid longitude {}", point.lon))
        })?;
        let lat = point.lat.parse::<f64>().map_err(|_| {
            OracleError::InvalidGridPoint(format!("invalid latitude {}", point.lat))
        })?;
        let cell = LatLng::new(lat, lon)
            .map_err(|_| OracleError::InvalidCoordinate)?
            .to_cell(Resolution::Seven);
        grouped
            .entry(u64::from(cell))
            .or_default()
            .push(point.mmi_x100);
    }

    let mut affected = Vec::new();
    for (h3_index, values) in grouped {
        let Some(intensity_value) = p90_x100(&values) else {
            continue;
        };
        let band = cell_band(intensity_value);
        if band >= MIN_CLAIM_BAND {
            affected.push(AffectedCellJson {
                h3_index: h3_index.to_string(),
                intensity_value,
                cell_band: band,
            });
        }
    }
    Ok(affected)
}
