use crate::compute::intensity::mmi_decimal_to_x100;
use crate::core::types::OracleError;
use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};
use serde::{Deserialize, Deserializer};
use std::collections::HashMap;
use std::io::{Cursor, Read};

// ShakeMap grid のサイズ上限。実測最大は約 29MiB（2026 Philippines M7.8 等）で、
// マグニチュードに比例せず extent×解像度で決まる。実測最大に十分な余裕を持たせ、
// 上限超えのみ OOM/DoS 防御として弾く。zip は圧縮済みのため XML 上限の半分を充てる。
pub(crate) const MAX_GRID_ZIP_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const MAX_GRID_XML_BYTES: usize = 128 * 1024 * 1024;
pub(crate) const MAX_GRID_ZIP_FILES: usize = 8;

#[derive(Debug, Deserialize)]
pub(crate) struct UsgsDetail {
    pub(crate) id: String,
    pub(crate) properties: UsgsProperties,
}

#[derive(Debug, Deserialize)]
pub(crate) struct UsgsProperties {
    pub(crate) time: u64,
    pub(crate) updated: u64,
    #[serde(
        default,
        rename = "mag",
        deserialize_with = "deserialize_optional_magnitude_x100"
    )]
    pub(crate) magnitude_x100: Option<u64>,
    #[serde(default)]
    pub(crate) title: Option<String>,
    #[serde(default, rename = "place")]
    pub(crate) region: Option<String>,
    #[serde(default)]
    pub(crate) ids: Option<String>,
    pub(crate) products: UsgsProducts,
}

#[derive(Debug, Deserialize)]
pub(crate) struct UsgsProducts {
    pub(crate) shakemap: Option<Vec<UsgsShakeMapProduct>>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct UsgsShakeMapProduct {
    #[serde(default)]
    pub(crate) code: Option<String>,
    #[serde(default)]
    pub(crate) source: Option<String>,
    #[serde(default)]
    pub(crate) status: Option<String>,
    #[serde(default, rename = "preferredWeight")]
    pub(crate) preferred_weight: Option<u64>,
    #[serde(default, rename = "updateTime")]
    pub(crate) update_time: Option<u64>,
    pub(crate) properties: UsgsShakeMapProperties,
    #[serde(default)]
    pub(crate) contents: HashMap<String, UsgsContent>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct UsgsShakeMapProperties {
    #[serde(rename = "map-status")]
    pub(crate) map_status: String,
    pub(crate) version: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct UsgsContent {
    pub(crate) url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GridPoint {
    pub(crate) lon: String,
    pub(crate) lat: String,
    pub(crate) mmi_x100: u16,
}

#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)]
pub(crate) struct StructuredGrid {
    pub(crate) lon_axis: Vec<f64>,
    pub(crate) lat_axis: Vec<f64>,
    pub(crate) bbox: GridBbox,
    mmi_by_coordinate: HashMap<(u64, u64), u16>,
}

impl StructuredGrid {
    #[allow(dead_code)]
    pub(crate) fn mmi_x100_at(&self, lon: f64, lat: f64) -> Option<u16> {
        self.mmi_by_coordinate
            .get(&(coordinate_key(lon), coordinate_key(lat)))
            .copied()
    }

    #[allow(dead_code)]
    pub(crate) fn contains(&self, lon: f64, lat: f64) -> bool {
        self.bbox.min_lon <= lon
            && lon <= self.bbox.max_lon
            && self.bbox.min_lat <= lat
            && lat <= self.bbox.max_lat
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
#[allow(dead_code)]
pub(crate) struct GridBbox {
    pub(crate) min_lon: f64,
    pub(crate) max_lon: f64,
    pub(crate) min_lat: f64,
    pub(crate) max_lat: f64,
}

fn deserialize_optional_magnitude_x100<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    let Some(value) = value else {
        return Ok(None);
    };
    let raw = match value {
        serde_json::Value::Number(number) => number.to_string(),
        serde_json::Value::String(value) => value,
        _ => {
            return Err(serde::de::Error::custom(
                "mag must be a JSON number or decimal string",
            ));
        }
    };
    magnitude_decimal_to_x100(&raw)
        .map(Some)
        .map_err(serde::de::Error::custom)
}

fn magnitude_decimal_to_x100(input: &str) -> Result<u64, String> {
    let value = input.trim();
    if value.is_empty() {
        return Err("magnitude is empty".to_owned());
    }
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(format!("invalid magnitude decimal {input}"));
    }
    let whole = whole
        .parse::<u64>()
        .map_err(|_| format!("invalid magnitude decimal {input}"))?;
    let mut digits = fraction.bytes().map(|byte| byte - b'0');
    let first = u64::from(digits.next().unwrap_or(0));
    let second = u64::from(digits.next().unwrap_or(0));
    let third = digits.next().unwrap_or(0);
    whole
        .checked_mul(100)
        .and_then(|base| base.checked_add(first * 10 + second))
        .and_then(|base| base.checked_add(u64::from(third >= 5)))
        .ok_or_else(|| format!("invalid magnitude decimal {input}"))
}

pub(crate) fn parse_detail(detail_json: &[u8]) -> Result<UsgsDetail, OracleError> {
    serde_json::from_slice(detail_json).map_err(OracleError::from)
}

pub(crate) fn detail_matches_source_event_id(detail: &UsgsDetail, source_event_id: &str) -> bool {
    detail.id == source_event_id || detail_aliases_contain(&detail.properties.ids, source_event_id)
}

fn detail_aliases_contain(ids: &Option<String>, source_event_id: &str) -> bool {
    ids.as_ref()
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .any(|alias| alias == source_event_id)
        })
        .unwrap_or(false)
}

pub(crate) fn select_preferred_shakemap_product(
    products: &[UsgsShakeMapProduct],
) -> Option<&UsgsShakeMapProduct> {
    products
        .iter()
        .max_by(|left, right| product_sort_key(left).cmp(&product_sort_key(right)))
}

fn product_sort_key(product: &UsgsShakeMapProduct) -> (u64, u64, u64, String, String, String) {
    (
        product.preferred_weight.unwrap_or(0),
        product
            .properties
            .version
            .parse::<u64>()
            .unwrap_or_default(),
        product.update_time.unwrap_or(0),
        product.source.clone().unwrap_or_default(),
        product.code.clone().unwrap_or_default(),
        product.status.clone().unwrap_or_default(),
    )
}

pub(crate) fn preferred_grid_uri(product: &UsgsShakeMapProduct) -> Option<&str> {
    product
        .contents
        .get("download/grid.xml.zip")
        .or_else(|| product.contents.get("download/grid.xml"))
        .map(|content| content.url.as_str())
}

pub fn grid_xml_from_artifact(uri: &str, bytes: &[u8]) -> Result<Vec<u8>, OracleError> {
    if uri.ends_with(".zip") {
        return grid_xml_from_zip(bytes);
    }
    if bytes.len() > MAX_GRID_XML_BYTES {
        return Err(OracleError::Zip("grid.xml exceeds maximum size".to_owned()));
    }
    Ok(bytes.to_vec())
}

pub(crate) fn grid_xml_from_zip(bytes: &[u8]) -> Result<Vec<u8>, OracleError> {
    if bytes.len() > MAX_GRID_ZIP_BYTES {
        return Err(OracleError::Zip(
            "grid.xml.zip exceeds maximum size".to_owned(),
        ));
    }

    let reader = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|error| OracleError::Zip(format!("cannot read archive: {error}")))?;
    if archive.len() > MAX_GRID_ZIP_FILES {
        return Err(OracleError::Zip(
            "grid.xml.zip contains too many files".to_owned(),
        ));
    }

    let mut found: Option<Vec<u8>> = None;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|error| OracleError::Zip(format!("cannot read zip entry: {error}")))?;
        let enclosed = file
            .enclosed_name()
            .ok_or_else(|| OracleError::Zip("zip entry path traversal rejected".to_owned()))?;
        if enclosed.to_string_lossy() != "grid.xml" {
            continue;
        }
        if found.is_some() {
            return Err(OracleError::Zip(
                "grid.xml.zip contains multiple grid.xml files".to_owned(),
            ));
        }
        let mut xml = Vec::new();
        file.by_ref()
            .take((MAX_GRID_XML_BYTES + 1) as u64)
            .read_to_end(&mut xml)
            .map_err(|error| OracleError::Zip(format!("cannot extract grid.xml: {error}")))?;
        if xml.len() > MAX_GRID_XML_BYTES {
            return Err(OracleError::Zip(
                "expanded grid.xml exceeds maximum size".to_owned(),
            ));
        }
        found = Some(xml);
    }

    found.ok_or_else(|| OracleError::Zip("grid.xml.zip does not contain grid.xml".to_owned()))
}

pub(crate) fn parse_grid_points(grid_xml: &[u8]) -> Result<Vec<GridPoint>, OracleError> {
    let mut reader = Reader::from_reader(grid_xml);
    reader.config_mut().trim_text(true);
    let mut inside_grid_data = false;
    let mut grid_text = String::new();
    let mut grid_columns = GridColumns::default();
    loop {
        match reader.read_event()? {
            Event::Empty(event) | Event::Start(event) if event.name().as_ref() == b"grid_field" => {
                grid_columns.apply_event(&event)?;
            }
            Event::Start(event) if event.name().as_ref() == b"grid_data" => {
                inside_grid_data = true;
            }
            Event::End(event) if event.name().as_ref() == b"grid_data" => {
                inside_grid_data = false;
            }
            Event::Text(text) if inside_grid_data => {
                let decoded = text
                    .decode()
                    .map_err(|err| OracleError::InvalidGridPoint(err.to_string()))?;
                grid_text.push_str(decoded.as_ref());
            }
            Event::Eof => break,
            _ => {}
        }
    }

    let tokens = grid_text.split_whitespace().collect::<Vec<_>>();
    if tokens.is_empty() {
        return Ok(Vec::new());
    }

    let Some(columns) = grid_columns.to_resolved()? else {
        if tokens.len() % 3 != 0 {
            return Err(OracleError::InvalidGridPoint(
                "grid_data must contain lon lat mmi triples".to_owned(),
            ));
        }
        return tokens
            .chunks_exact(3)
            .map(|chunk| grid_point_from_fields(chunk[0], chunk[1], chunk[2]))
            .collect();
    };

    if tokens.len() % columns.stride != 0 {
        return Err(OracleError::InvalidGridPoint(
            "grid_data field count does not match grid_field definitions".to_owned(),
        ));
    }
    tokens
        .chunks_exact(columns.stride)
        .map(|chunk| {
            let lon = chunk.get(columns.lon).ok_or_else(|| {
                OracleError::InvalidGridPoint("LON grid_field index is out of range".to_owned())
            })?;
            let lat = chunk.get(columns.lat).ok_or_else(|| {
                OracleError::InvalidGridPoint("LAT grid_field index is out of range".to_owned())
            })?;
            let mmi = chunk.get(columns.mmi).ok_or_else(|| {
                OracleError::InvalidGridPoint("MMI grid_field index is out of range".to_owned())
            })?;
            grid_point_from_fields(lon, lat, mmi)
        })
        .collect()
}

#[allow(dead_code)]
pub(crate) fn structured_grid_from_points(
    points: &[GridPoint],
) -> Result<StructuredGrid, OracleError> {
    let first = points
        .first()
        .ok_or_else(|| OracleError::InvalidGridPoint("grid_data contains no points".to_owned()))?;
    let first_lon = parse_grid_lon(&first.lon)?;
    let first_lat = parse_grid_lat(&first.lat)?;
    let mut lon_axis = vec![first_lon];
    let mut lat_axis = vec![first_lat];
    let mut bbox = GridBbox {
        min_lon: first_lon,
        max_lon: first_lon,
        min_lat: first_lat,
        max_lat: first_lat,
    };
    let mut mmi_by_coordinate = HashMap::<(u64, u64), u16>::new();

    for point in points {
        let lon = parse_grid_lon(&point.lon)?;
        let lat = parse_grid_lat(&point.lat)?;
        lon_axis.push(lon);
        lat_axis.push(lat);
        bbox.min_lon = bbox.min_lon.min(lon);
        bbox.max_lon = bbox.max_lon.max(lon);
        bbox.min_lat = bbox.min_lat.min(lat);
        bbox.max_lat = bbox.max_lat.max(lat);
        mmi_by_coordinate
            .entry((coordinate_key(lon), coordinate_key(lat)))
            .and_modify(|current| *current = (*current).max(point.mmi_x100))
            .or_insert(point.mmi_x100);
    }

    sort_unique_f64(&mut lon_axis);
    sort_unique_f64(&mut lat_axis);

    Ok(StructuredGrid {
        lon_axis,
        lat_axis,
        bbox,
        mmi_by_coordinate,
    })
}

#[allow(dead_code)]
fn sort_unique_f64(values: &mut Vec<f64>) {
    values.sort_by(|left, right| left.total_cmp(right));
    values.dedup_by(|left, right| coordinate_key(*left) == coordinate_key(*right));
}

#[allow(dead_code)]
fn coordinate_key(value: f64) -> u64 {
    value.to_bits()
}

#[derive(Debug, Default)]
struct GridColumns {
    lon: Option<usize>,
    lat: Option<usize>,
    mmi: Option<usize>,
    max_index: usize,
    saw_field: bool,
}

impl GridColumns {
    fn apply_event(&mut self, event: &BytesStart<'_>) -> Result<(), OracleError> {
        let mut index: Option<usize> = None;
        let mut name: Option<String> = None;
        for attribute in event.attributes() {
            let attribute = attribute.map_err(|error| {
                OracleError::InvalidGridPoint(format!("invalid grid_field attribute: {error}"))
            })?;
            match attribute.key.as_ref() {
                b"index" => {
                    let value = std::str::from_utf8(attribute.value.as_ref()).map_err(|error| {
                        OracleError::InvalidGridPoint(format!(
                            "invalid grid_field index encoding: {error}"
                        ))
                    })?;
                    let parsed = value.parse::<usize>().map_err(|_| {
                        OracleError::InvalidGridPoint(format!("invalid grid_field index {value}"))
                    })?;
                    if parsed == 0 {
                        return Err(OracleError::InvalidGridPoint(
                            "grid_field index must be one-based".to_owned(),
                        ));
                    }
                    index = Some(parsed - 1);
                    self.max_index = self.max_index.max(parsed);
                }
                b"name" => {
                    let value = std::str::from_utf8(attribute.value.as_ref()).map_err(|error| {
                        OracleError::InvalidGridPoint(format!(
                            "invalid grid_field name encoding: {error}"
                        ))
                    })?;
                    name = Some(value.to_owned());
                }
                _ => {}
            }
        }
        let Some(index) = index else {
            return Ok(());
        };
        let Some(name) = name else {
            return Ok(());
        };
        self.saw_field = true;
        if name.eq_ignore_ascii_case("LON") {
            self.lon = Some(index);
        } else if name.eq_ignore_ascii_case("LAT") {
            self.lat = Some(index);
        } else if name.eq_ignore_ascii_case("MMI") {
            self.mmi = Some(index);
        }
        Ok(())
    }

    fn to_resolved(&self) -> Result<Option<ResolvedGridColumns>, OracleError> {
        if !self.saw_field {
            return Ok(None);
        }
        let lon = self.lon.ok_or_else(|| {
            OracleError::InvalidGridPoint("grid_field LON column is required".to_owned())
        })?;
        let lat = self.lat.ok_or_else(|| {
            OracleError::InvalidGridPoint("grid_field LAT column is required".to_owned())
        })?;
        let mmi = self.mmi.ok_or_else(|| {
            OracleError::InvalidGridPoint("grid_field MMI column is required".to_owned())
        })?;
        let stride = self.max_index.max(lon + 1).max(lat + 1).max(mmi + 1);
        Ok(Some(ResolvedGridColumns {
            lon,
            lat,
            mmi,
            stride,
        }))
    }
}

#[derive(Debug)]
struct ResolvedGridColumns {
    lon: usize,
    lat: usize,
    mmi: usize,
    stride: usize,
}

fn grid_point_from_fields(
    lon_raw: &str,
    lat_raw: &str,
    mmi_raw: &str,
) -> Result<GridPoint, OracleError> {
    parse_grid_lon(lon_raw)?;
    parse_grid_lat(lat_raw)?;
    Ok(GridPoint {
        lon: lon_raw.to_owned(),
        lat: lat_raw.to_owned(),
        mmi_x100: mmi_decimal_to_x100(mmi_raw)?,
    })
}

fn parse_grid_lon(lon_raw: &str) -> Result<f64, OracleError> {
    parse_grid_coordinate(lon_raw, "longitude")
}

fn parse_grid_lat(lat_raw: &str) -> Result<f64, OracleError> {
    parse_grid_coordinate(lat_raw, "latitude")
}

fn parse_grid_coordinate(raw: &str, label: &str) -> Result<f64, OracleError> {
    let value = raw
        .parse::<f64>()
        .map_err(|_| OracleError::InvalidGridPoint(format!("invalid {label} {raw}")))?;
    if !value.is_finite() {
        return Err(OracleError::InvalidGridPoint(
            "coordinates must be finite".to_owned(),
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_GRID_XML_BYTES, MAX_GRID_ZIP_BYTES, grid_xml_from_artifact, parse_grid_points,
        structured_grid_from_points,
    };

    const MIB: usize = 1024 * 1024;

    #[test]
    fn grid_size_caps_match_expected_values() {
        // Issue #228: 実測最大約 29MiB の grid を finalize できるよう上限を拡張する。
        assert_eq!(MAX_GRID_XML_BYTES, 128 * MIB);
        assert_eq!(MAX_GRID_ZIP_BYTES, 64 * MIB);
    }

    #[test]
    fn grid_xml_from_artifact_accepts_large_grid_below_xml_cap() {
        // 旧上限 16MiB を超える実在サイズ（約30MiB）の grid.xml を受理できること。
        // uri は .zip 以外にし、XML 直経路を通す。
        let bytes = vec![b' '; 30 * MIB];
        let result = grid_xml_from_artifact("https://example.com/download/grid.xml", &bytes)
            .expect("30MiB grid.xml should be accepted under the 128MiB cap");
        assert_eq!(result.len(), 30 * MIB);
    }

    #[test]
    fn grid_xml_from_artifact_rejects_grid_above_xml_cap() {
        // 上限直上（128MiB+1）は OOM/DoS 防御として従来どおり拒否する。
        let bytes = vec![b' '; MAX_GRID_XML_BYTES + 1];
        let error = grid_xml_from_artifact("https://example.com/download/grid.xml", &bytes)
            .expect_err("grid.xml above the cap must be rejected");
        assert!(error.to_string().contains("exceeds maximum size"));
    }

    #[test]
    fn parse_grid_points_uses_grid_field_indexes_for_multicolumn_shakemap() {
        let grid_xml = br#"
            <shakemap_grid>
              <grid_field index="1" name="LON" units="dd" />
              <grid_field index="2" name="LAT" units="dd" />
              <grid_field index="3" name="MMI" units="intensity" />
              <grid_field index="4" name="PGA" units="%g" />
              <grid_data>
                134.7333 45.1000 2.3 0.1836
                134.7667 45.1000 2.4 0.1866
              </grid_data>
            </shakemap_grid>
        "#;

        let points = parse_grid_points(grid_xml).expect("multicolumn grid should parse");

        assert_eq!(points.len(), 2);
        assert_eq!(points[0].lon, "134.7333");
        assert_eq!(points[0].lat, "45.1000");
        assert_eq!(points[0].mmi_x100, 230);
        assert_eq!(points[1].lon, "134.7667");
        assert_eq!(points[1].lat, "45.1000");
        assert_eq!(points[1].mmi_x100, 240);
    }

    #[test]
    fn parse_grid_structured_grid_uses_unique_sorted_axes_bbox_and_max_duplicate_mmi() {
        let grid_xml = br#"
            <shakemap_grid>
              <grid_field index="1" name="LON" units="dd" />
              <grid_field index="2" name="LAT" units="dd" />
              <grid_field index="3" name="MMI" units="intensity" />
              <grid_data>
                134.80 45.20 2.1
                134.70 45.10 2.2
                134.80 45.10 2.3
                134.70 45.10 2.9
              </grid_data>
            </shakemap_grid>
        "#;

        let points = parse_grid_points(grid_xml).expect("grid points should parse");
        let grid = structured_grid_from_points(&points).expect("grid should be structured");

        assert_eq!(grid.lon_axis, vec![134.70, 134.80]);
        assert_eq!(grid.lat_axis, vec![45.10, 45.20]);
        assert_eq!(grid.bbox.min_lon, 134.70);
        assert_eq!(grid.bbox.max_lon, 134.80);
        assert_eq!(grid.bbox.min_lat, 45.10);
        assert_eq!(grid.bbox.max_lat, 45.20);
        assert_eq!(grid.mmi_x100_at(134.70, 45.10), Some(290));
        assert_eq!(grid.mmi_x100_at(134.80, 45.10), Some(230));
        assert_eq!(grid.mmi_x100_at(134.70, 45.20), None);
    }

    #[test]
    fn parse_grid_structured_grid_accepts_nonuniform_spacing_and_missing_edge_points() {
        let grid_xml = br#"
            <shakemap_grid>
              <grid_field index="1" name="LON" units="dd" />
              <grid_field index="2" name="LAT" units="dd" />
              <grid_field index="3" name="MMI" units="intensity" />
              <grid_data>
                134.70 45.10 2.1
                134.83 45.10 2.2
                135.40 45.90 2.4
              </grid_data>
            </shakemap_grid>
        "#;

        let points = parse_grid_points(grid_xml).expect("grid points should parse");
        let grid = structured_grid_from_points(&points)
            .expect("nonuniform sparse grid should be accepted");

        assert_eq!(grid.lon_axis, vec![134.70, 134.83, 135.40]);
        assert_eq!(grid.lat_axis, vec![45.10, 45.90]);
        assert_eq!(grid.mmi_x100_at(134.83, 45.90), None);
    }

    #[test]
    fn parse_grid_structured_grid_rejects_empty_points() {
        let error = structured_grid_from_points(&[]).expect_err("empty grid must fail");

        assert!(error.to_string().contains("grid_data contains no points"));
    }

    #[test]
    fn parse_grid_points_rejects_non_numeric_mmi() {
        let grid_xml = br#"
            <shakemap_grid>
              <grid_field index="1" name="LON" units="dd" />
              <grid_field index="2" name="LAT" units="dd" />
              <grid_field index="3" name="MMI" units="intensity" />
              <grid_data>134.70 45.10 not-a-number</grid_data>
            </shakemap_grid>
        "#;

        let error = parse_grid_points(grid_xml).expect_err("non-numeric MMI must fail");

        assert!(error.to_string().contains("invalid MMI"));
    }

    #[test]
    fn parse_grid_points_rejects_missing_required_grid_fields() {
        let grid_xml = br#"
            <shakemap_grid>
              <grid_field index="1" name="LON" units="dd" />
              <grid_field index="2" name="LAT" units="dd" />
              <grid_data>134.70 45.10</grid_data>
            </shakemap_grid>
        "#;

        let error = parse_grid_points(grid_xml).expect_err("missing MMI field must fail");

        assert!(
            error
                .to_string()
                .contains("grid_field MMI column is required")
        );
    }
}
