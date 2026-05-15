use crate::intensity::mmi_decimal_to_x100;
use crate::types::OracleError;
use quick_xml::Reader;
use quick_xml::events::Event;
use serde::Deserialize;
use std::collections::HashMap;

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
