use crate::MIN_CLAIM_BAND;
use crate::compute::intensity::{cell_band, p90_x100};
use crate::core::artifacts::AffectedCellJson;
use crate::core::types::OracleError;
use crate::source::usgs::{GridPoint, StructuredGrid};
use h3o::{CellIndex, LatLng, Resolution};
use std::collections::{BTreeMap, BTreeSet};

#[allow(dead_code)]
const H3_BBOX_SCAN_STEP_DEGREES: f64 = 0.01;
#[allow(dead_code)]
const H3_BBOX_SCAN_PADDING_DEGREES: f64 = 0.05;
const MAX_H3_BBOX_SCAN_POINTS: u64 = 5_000_000;

#[allow(dead_code)]
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

#[allow(dead_code)]
pub(crate) fn affected_cells_from_grid_centers(
    grid: &StructuredGrid,
) -> Result<Vec<AffectedCellJson>, OracleError> {
    let candidates = h3_cells_covering_grid_bbox(grid)?;
    let mut affected = Vec::new();
    for h3_index in candidates {
        let center = LatLng::from(h3_index);
        let lon = center.lng();
        let lat = center.lat();
        if !grid.contains(lon, lat) {
            continue;
        }
        let Some(intensity_value) = interpolated_mmi_x100(grid, lon, lat) else {
            continue;
        };
        let band = cell_band(intensity_value);
        if band >= MIN_CLAIM_BAND {
            affected.push(AffectedCellJson {
                h3_index: u64::from(h3_index).to_string(),
                intensity_value,
                cell_band: band,
            });
        }
    }
    Ok(affected)
}

#[allow(dead_code)]
fn h3_cells_covering_grid_bbox(grid: &StructuredGrid) -> Result<BTreeSet<CellIndex>, OracleError> {
    let min_lon = grid.bbox.min_lon - H3_BBOX_SCAN_PADDING_DEGREES;
    let max_lon = grid.bbox.max_lon + H3_BBOX_SCAN_PADDING_DEGREES;
    let min_lat = grid.bbox.min_lat - H3_BBOX_SCAN_PADDING_DEGREES;
    let max_lat = grid.bbox.max_lat + H3_BBOX_SCAN_PADDING_DEGREES;
    if !(min_lon <= max_lon && min_lat <= max_lat) {
        return Err(OracleError::InvalidGridPoint(
            "invalid ShakeMap grid bbox".to_owned(),
        ));
    }
    let lon_steps = scan_steps(min_lon, max_lon)?;
    let lat_steps = scan_steps(min_lat, max_lat)?;
    let scan_points = lon_steps.checked_mul(lat_steps).ok_or_else(|| {
        OracleError::InvalidGridPoint("ShakeMap grid bbox scan count overflow".to_owned())
    })?;
    if scan_points > MAX_H3_BBOX_SCAN_POINTS {
        return Err(OracleError::InvalidGridPoint(format!(
            "ShakeMap grid bbox scan count {scan_points} exceeds limit {MAX_H3_BBOX_SCAN_POINTS}"
        )));
    }

    let mut cells = BTreeSet::new();
    let mut lat = min_lat;
    while lat <= max_lat {
        let mut lon = min_lon;
        while lon <= max_lon {
            let center = LatLng::new(lat, lon).map_err(|_| OracleError::InvalidCoordinate)?;
            let cell = center.to_cell(Resolution::Seven);
            cells.insert(cell);
            cells.extend(cell.grid_disk::<Vec<_>>(1));
            lon += H3_BBOX_SCAN_STEP_DEGREES;
        }
        lat += H3_BBOX_SCAN_STEP_DEGREES;
    }
    if cells.is_empty() {
        return Err(OracleError::InvalidGridPoint(
            "H3 bbox enumeration produced no cells".to_owned(),
        ));
    }
    Ok(cells)
}

fn scan_steps(min: f64, max: f64) -> Result<u64, OracleError> {
    let span = max - min;
    if !(span.is_finite() && span >= 0.0) {
        return Err(OracleError::InvalidGridPoint(
            "invalid ShakeMap grid bbox span".to_owned(),
        ));
    }
    Ok((span / H3_BBOX_SCAN_STEP_DEGREES).floor() as u64 + 1)
}

#[allow(dead_code)]
fn interpolated_mmi_x100(grid: &StructuredGrid, lon: f64, lat: f64) -> Option<u16> {
    let (left_lon, right_lon) = bracket_axis(&grid.lon_axis, lon)?;
    let (lower_lat, upper_lat) = bracket_axis(&grid.lat_axis, lat)?;
    let corners = [
        (left_lon, lower_lat),
        (right_lon, lower_lat),
        (left_lon, upper_lat),
        (right_lon, upper_lat),
    ];
    let values = corners
        .into_iter()
        .filter_map(|(corner_lon, corner_lat)| grid.mmi_x100_at(corner_lon, corner_lat))
        .collect::<Vec<_>>();
    if values.len() < 4 {
        return values.into_iter().max();
    }

    let q11 = f64::from(grid.mmi_x100_at(left_lon, lower_lat)?);
    let q21 = f64::from(grid.mmi_x100_at(right_lon, lower_lat)?);
    let q12 = f64::from(grid.mmi_x100_at(left_lon, upper_lat)?);
    let q22 = f64::from(grid.mmi_x100_at(right_lon, upper_lat)?);
    if (left_lon == right_lon) || (lower_lat == upper_lat) {
        return [q11, q21, q12, q22]
            .into_iter()
            .map(|value| value.round() as u16)
            .max();
    }

    let tx = (lon - left_lon) / (right_lon - left_lon);
    let ty = (lat - lower_lat) / (upper_lat - lower_lat);
    let lower = q11.mul_add(1.0 - tx, q21 * tx);
    let upper = q12.mul_add(1.0 - tx, q22 * tx);
    let interpolated = lower.mul_add(1.0 - ty, upper * ty);
    Some(interpolated.round().clamp(0.0, f64::from(u16::MAX)) as u16)
}

#[allow(dead_code)]
fn bracket_axis(axis: &[f64], value: f64) -> Option<(f64, f64)> {
    if axis.is_empty() || value < *axis.first()? || value > *axis.last()? {
        return None;
    }
    match axis.binary_search_by(|probe| probe.total_cmp(&value)) {
        Ok(index) => {
            let axis_value = axis[index];
            Some((axis_value, axis_value))
        }
        Err(index) if index == 0 || index >= axis.len() => None,
        Err(index) => Some((axis[index - 1], axis[index])),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::usgs::{GridPoint, structured_grid_from_points};

    fn point(lon: &str, lat: &str, mmi_x100: u16) -> GridPoint {
        GridPoint {
            lon: lon.to_owned(),
            lat: lat.to_owned(),
            mmi_x100,
        }
    }

    fn grid(points: Vec<GridPoint>) -> StructuredGrid {
        structured_grid_from_points(&points).expect("test grid should structure")
    }

    #[test]
    fn affected_cells_interpolates_grid_center_from_four_corners() {
        let grid = grid(vec![
            point("139.00", "35.00", 700),
            point("139.10", "35.00", 800),
            point("139.00", "35.10", 900),
            point("139.10", "35.10", 1000),
        ]);

        assert_eq!(interpolated_mmi_x100(&grid, 139.05, 35.05), Some(850));
    }

    #[test]
    fn affected_cells_uses_max_available_mmi_when_corner_is_missing() {
        let grid = grid(vec![
            point("139.00", "35.00", 700),
            point("139.10", "35.00", 820),
            point("139.00", "35.10", 910),
        ]);

        assert_eq!(interpolated_mmi_x100(&grid, 139.05, 35.05), Some(910));
    }

    #[test]
    fn affected_cells_excludes_centers_outside_grid_bbox() {
        let grid = grid(vec![
            point("139.00", "35.00", 700),
            point("139.10", "35.00", 800),
            point("139.00", "35.10", 900),
            point("139.10", "35.10", 1000),
        ]);

        assert_eq!(interpolated_mmi_x100(&grid, 139.11, 35.05), None);
    }

    #[test]
    fn affected_cells_from_grid_centers_outputs_band_one_or_higher_in_numeric_order() {
        let grid = grid(vec![
            point("139.00", "35.00", 710),
            point("139.04", "35.00", 710),
            point("139.00", "35.04", 710),
            point("139.04", "35.04", 710),
        ]);

        let affected = affected_cells_from_grid_centers(&grid).expect("cells should compute");

        assert!(!affected.is_empty());
        assert!(affected.iter().all(|cell| cell.cell_band >= MIN_CLAIM_BAND));
        let h3_indexes = affected
            .iter()
            .map(|cell| cell.h3_index.parse::<u64>().unwrap())
            .collect::<Vec<_>>();
        let mut sorted = h3_indexes.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(h3_indexes, sorted);
    }

    #[test]
    fn affected_cells_rejects_sparse_grid_with_huge_bbox_scan() {
        let grid = grid(vec![
            point("0.0", "0.0", 800),
            point("100.0", "0.0", 800),
            point("0.0", "50.0", 800),
            point("100.0", "50.0", 800),
        ]);

        let error = affected_cells_from_grid_centers(&grid)
            .expect_err("huge sparse bbox must fail closed before scanning");

        assert!(
            matches!(error, OracleError::InvalidGridPoint(message) if message.contains("bbox scan count"))
        );
    }

    #[test]
    fn affected_cells_cover_all_bbox_center_cells_for_small_bbox() {
        let grid = grid(vec![
            point("139.00", "35.00", 710),
            point("139.03", "35.00", 710),
            point("139.00", "35.03", 710),
            point("139.03", "35.03", 710),
        ]);

        let candidates = h3_cells_covering_grid_bbox(&grid).expect("bbox should enumerate");
        let expected = candidates
            .iter()
            .filter(|cell| {
                let center = LatLng::from(**cell);
                grid.contains(center.lng(), center.lat())
            })
            .map(|cell| u64::from(*cell))
            .collect::<BTreeSet<_>>();
        let affected = affected_cells_from_grid_centers(&grid).expect("cells should compute");
        let actual = affected
            .iter()
            .map(|cell| cell.h3_index.parse::<u64>().unwrap())
            .collect::<BTreeSet<_>>();

        assert_eq!(actual, expected);
    }
}
