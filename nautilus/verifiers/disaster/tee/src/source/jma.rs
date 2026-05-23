use crate::core::types::OracleError;
use quick_xml::Reader;
use quick_xml::events::Event;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct JmaVxse53Event {
    pub(crate) event_id: String,
    pub(crate) serial: String,
    pub(crate) report_time_ms: u64,
    pub(crate) target_time_ms: u64,
    pub(crate) origin_time_ms: u64,
    pub(crate) max_shindo: Option<String>,
    pub(crate) max_shindo_x10: Option<u16>,
    pub(crate) hypocenter_name: Option<String>,
    pub(crate) hypocenter_lat_e7: Option<i32>,
    pub(crate) hypocenter_lon_e7: Option<i32>,
    pub(crate) hypocenter_depth_m: Option<i32>,
}

pub(crate) fn parse_vxse53_event(xml: &[u8]) -> Result<JmaVxse53Event, OracleError> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(true);
    let mut stack: Vec<String> = Vec::new();
    let mut report_time: Option<String> = None;
    let mut target_time: Option<String> = None;
    let mut event_id: Option<String> = None;
    let mut serial: Option<String> = None;
    let mut origin_time: Option<String> = None;
    let mut max_shindo: Option<String> = None;
    let mut hypocenter_name: Option<String> = None;
    let mut coordinate: Option<String> = None;

    loop {
        match reader.read_event()? {
            Event::Start(event) => {
                let name = std::str::from_utf8(event.name().as_ref())?.to_owned();
                stack.push(name);
            }
            Event::End(_) => {
                stack.pop();
            }
            Event::Text(text) => {
                let value = text
                    .decode()
                    .map_err(|err| OracleError::JmaXml(err.to_string()))?
                    .into_owned();
                match stack_path(&stack).as_str() {
                    "Report/Head/ReportDateTime" => report_time = Some(value),
                    "Report/Head/TargetDateTime" => target_time = Some(value),
                    "Report/Head/EventID" => event_id = Some(value),
                    "Report/Head/Serial" => serial = Some(value),
                    "Report/Body/Earthquake/OriginTime" => origin_time = Some(value),
                    "Report/Body/Earthquake/Hypocenter/Area/Name" => hypocenter_name = Some(value),
                    "Report/Body/Earthquake/Hypocenter/Area/Coordinate" => coordinate = Some(value),
                    "Report/Body/Intensity/Observation/MaxInt" => max_shindo = Some(value),
                    _ => {}
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }

    let event_id = required(event_id, "EventID")?;
    let serial = required(serial, "Serial")?;
    let report_time_ms = parse_jma_datetime_ms(&required(report_time, "ReportDateTime")?)?;
    let target_time_ms = parse_jma_datetime_ms(&required(target_time, "TargetDateTime")?)?;
    let origin_time_ms = parse_jma_datetime_ms(&required(origin_time, "OriginTime")?)?;
    let (hypocenter_lat_e7, hypocenter_lon_e7, hypocenter_depth_m) = coordinate
        .as_deref()
        .map(parse_coordinate)
        .transpose()?
        .unwrap_or((None, None, None));
    let max_shindo_x10 = max_shindo.as_deref().map(shindo_to_x10).transpose()?;

    Ok(JmaVxse53Event {
        event_id,
        serial,
        report_time_ms,
        target_time_ms,
        origin_time_ms,
        max_shindo,
        max_shindo_x10,
        hypocenter_name,
        hypocenter_lat_e7,
        hypocenter_lon_e7,
        hypocenter_depth_m,
    })
}

fn stack_path(stack: &[String]) -> String {
    stack.join("/")
}

fn required(value: Option<String>, name: &str) -> Result<String, OracleError> {
    value.ok_or_else(|| OracleError::JmaXml(format!("{name} is required")))
}

fn shindo_to_x10(value: &str) -> Result<u16, OracleError> {
    match value {
        "0" => Ok(0),
        "1" => Ok(10),
        "2" => Ok(20),
        "3" => Ok(30),
        "4" => Ok(40),
        "5弱" => Ok(45),
        "5強" => Ok(50),
        "6弱" => Ok(55),
        "6強" => Ok(60),
        "7" => Ok(70),
        other => Err(OracleError::JmaXml(format!("unsupported MaxInt {other}"))),
    }
}

fn parse_coordinate(value: &str) -> Result<(Option<i32>, Option<i32>, Option<i32>), OracleError> {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok((None, None, None));
    }
    let bytes = trimmed.as_bytes();
    let mut signs = Vec::new();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'+' || *byte == b'-' {
            signs.push(index);
        }
    }
    if signs.len() < 2 {
        return Err(OracleError::JmaXml(format!("invalid Coordinate {value}")));
    }
    let lat = &trimmed[signs[0]..signs[1]];
    let lon_end = signs.get(2).copied().unwrap_or(trimmed.len());
    let lon = &trimmed[signs[1]..lon_end];
    let depth = signs
        .get(2)
        .map(|start| trimmed[*start..].parse::<i32>())
        .transpose()
        .map_err(|_| OracleError::JmaXml(format!("invalid Coordinate depth {value}")))?;

    Ok((
        Some(parse_signed_decimal_e7(lat)?),
        Some(parse_signed_decimal_e7(lon)?),
        depth,
    ))
}

fn parse_signed_decimal_e7(value: &str) -> Result<i32, OracleError> {
    let parsed = value
        .parse::<f64>()
        .map_err(|_| OracleError::JmaXml(format!("invalid decimal coordinate {value}")))?;
    if !parsed.is_finite() {
        return Err(OracleError::JmaXml(format!(
            "non-finite coordinate {value}"
        )));
    }
    Ok((parsed * 10_000_000.0).round() as i32)
}

fn parse_jma_datetime_ms(value: &str) -> Result<u64, OracleError> {
    if value.len() != 25 {
        return Err(OracleError::JmaXml(format!("invalid datetime {value}")));
    }
    let year = parse_u32(value, 0, 4, "year")? as i32;
    let month = parse_u32(value, 5, 7, "month")?;
    let day = parse_u32(value, 8, 10, "day")?;
    let hour = parse_u32(value, 11, 13, "hour")?;
    let minute = parse_u32(value, 14, 16, "minute")?;
    let second = parse_u32(value, 17, 19, "second")?;
    let offset_sign = match &value[19..20] {
        "+" => 1_i64,
        "-" => -1_i64,
        _ => {
            return Err(OracleError::JmaXml(format!(
                "invalid datetime offset {value}"
            )));
        }
    };
    let offset_hour = parse_u32(value, 20, 22, "offset hour")? as i64;
    let offset_minute = parse_u32(value, 23, 25, "offset minute")? as i64;
    let offset_seconds = offset_sign * (offset_hour * 3600 + offset_minute * 60);
    let local_seconds = days_from_civil(year, month, day)? * 86_400
        + hour as i64 * 3600
        + minute as i64 * 60
        + second as i64;
    let utc_seconds = local_seconds - offset_seconds;
    u64::try_from(utc_seconds)
        .map(|seconds| seconds * 1000)
        .map_err(|_| OracleError::JmaXml(format!("datetime before unix epoch {value}")))
}

fn parse_u32(value: &str, start: usize, end: usize, name: &str) -> Result<u32, OracleError> {
    value[start..end]
        .parse::<u32>()
        .map_err(|_| OracleError::JmaXml(format!("invalid datetime {name} in {value}")))
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Result<i64, OracleError> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(OracleError::JmaXml("invalid calendar date".to_owned()));
    }
    let year = year - i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month as i32;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day as i32 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Ok((era * 146_097 + doe - 719_468) as i64)
}
