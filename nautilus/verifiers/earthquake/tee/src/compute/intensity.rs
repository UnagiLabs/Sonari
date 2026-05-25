use crate::core::types::OracleError;

pub fn mmi_decimal_to_x100(input: &str) -> Result<u16, OracleError> {
    let value = input.trim();
    if value.is_empty() {
        return Err(OracleError::InvalidMmi(input.to_owned()));
    }
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(OracleError::InvalidMmi(input.to_owned()));
    }
    let whole = whole
        .parse::<u32>()
        .map_err(|_| OracleError::InvalidMmi(input.to_owned()))?;
    let mut digits = fraction.bytes().map(|byte| byte - b'0');
    let first = digits.next().unwrap_or(0) as u32;
    let second = digits.next().unwrap_or(0) as u32;
    let third = digits.next().unwrap_or(0);
    let rounded = whole
        .checked_mul(100)
        .and_then(|base| base.checked_add(first * 10 + second))
        .and_then(|base| base.checked_add(u32::from(third >= 5)))
        .ok_or_else(|| OracleError::InvalidMmi(input.to_owned()))?;
    u16::try_from(rounded).map_err(|_| OracleError::InvalidMmi(input.to_owned()))
}

pub fn p90_x100(values: &[u16]) -> Option<u16> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let rank = (sorted.len() * 90).div_ceil(100) - 1;
    sorted.get(rank).copied()
}

pub const fn cell_band(mmi_x100: u16) -> u8 {
    match mmi_x100 {
        0..=699 => 0,
        700..=799 => 1,
        800..=899 => 2,
        _ => 3,
    }
}
