use crate::compute::intensity::mmi_decimal_to_x100;
use crate::core::types::OracleError;
use quick_xml::Reader;
use quick_xml::events::Event;
use serde::Deserialize;
use std::collections::HashMap;
use std::io::{Cursor, Read};

pub(crate) const MAX_GRID_ZIP_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_GRID_XML_BYTES: usize = 16 * 1024 * 1024;
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

pub(crate) fn parse_detail(detail_json: &[u8]) -> Result<UsgsDetail, OracleError> {
    serde_json::from_slice(detail_json).map_err(OracleError::from)
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
    loop {
        match reader.read_event()? {
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
    if tokens.len() % 3 != 0 {
        return Err(OracleError::InvalidGridPoint(
            "grid_data must contain lon lat mmi triples".to_owned(),
        ));
    }
    tokens
        .chunks_exact(3)
        .map(|chunk| {
            let lon = chunk[0].parse::<f64>().map_err(|_| {
                OracleError::InvalidGridPoint(format!("invalid longitude {}", chunk[0]))
            })?;
            let lat = chunk[1].parse::<f64>().map_err(|_| {
                OracleError::InvalidGridPoint(format!("invalid latitude {}", chunk[1]))
            })?;
            if !lon.is_finite() || !lat.is_finite() {
                return Err(OracleError::InvalidGridPoint(
                    "coordinates must be finite".to_owned(),
                ));
            }
            Ok(GridPoint {
                lon: chunk[0].to_owned(),
                lat: chunk[1].to_owned(),
                mmi_x100: mmi_decimal_to_x100(chunk[2])?,
            })
        })
        .collect()
}
