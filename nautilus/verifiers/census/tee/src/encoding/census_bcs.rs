use crate::{
    BAND_COUNT, CensusError, FloorCensusResult, INTENT, VERIFIER_FAMILY, VERIFIER_VERSION,
};
use serde::Serialize;
use sonari_tee_core::hex_to_32;

#[derive(Serialize)]
struct FloorCensusResultBcs {
    intent: Vec<u8>,
    verifier_family: Vec<u8>,
    verifier_version: u64,
    event_uid: [u8; 32],
    event_revision: u32,
    affected_cells_root: [u8; 32],
    registered_members_by_band: Vec<u64>,
    issued_at_ms: u64,
}

pub fn payload_bcs_bytes(result: &FloorCensusResult) -> Result<Vec<u8>, CensusError> {
    validate_contract_constants(result)?;
    validate_band_count(result)?;

    bcs::to_bytes(&FloorCensusResultBcs {
        intent: result.intent.as_bytes().to_vec(),
        verifier_family: result.verifier_family.as_bytes().to_vec(),
        verifier_version: result.verifier_version,
        event_uid: hex_to_32(&result.event_uid)?,
        event_revision: result.event_revision,
        affected_cells_root: hex_to_32(&result.affected_cells_root)?,
        registered_members_by_band: result.registered_members_by_band.clone(),
        issued_at_ms: result.issued_at_ms,
    })
    .map_err(CensusError::from)
}

fn validate_contract_constants(result: &FloorCensusResult) -> Result<(), CensusError> {
    if result.intent != INTENT {
        return invalid_payload("intent must match the floor census contract");
    }
    if result.verifier_family != VERIFIER_FAMILY {
        return invalid_payload("verifier_family must match the floor census contract");
    }
    if result.verifier_version != VERIFIER_VERSION {
        return invalid_payload("verifier_version must match the floor census contract");
    }
    Ok(())
}

fn validate_band_count(result: &FloorCensusResult) -> Result<(), CensusError> {
    if result.registered_members_by_band.len() != BAND_COUNT {
        return invalid_payload("registered_members_by_band must contain exactly 3 entries");
    }
    Ok(())
}

fn invalid_payload<T>(message: &str) -> Result<T, CensusError> {
    Err(CensusError::InvalidPayload(message.to_owned()))
}

#[cfg(test)]
mod tests {
    use crate::encoding::census_bcs::payload_bcs_bytes;
    use crate::{INTENT, VERIFIER_FAMILY, VERIFIER_VERSION};

    fn valid_result() -> crate::FloorCensusResult {
        crate::FloorCensusResult {
            intent: INTENT.to_owned(),
            verifier_family: VERIFIER_FAMILY.to_owned(),
            verifier_version: VERIFIER_VERSION,
            event_uid: "0x1111111111111111111111111111111111111111111111111111111111111111"
                .to_owned(),
            event_revision: 1,
            affected_cells_root:
                "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
            registered_members_by_band: vec![100, 200, 300],
            issued_at_ms: 1_800_000_000_000,
        }
    }

    #[test]
    fn bcs_matches_move_valid_fixture() {
        let bytes = payload_bcs_bytes(&valid_result()).unwrap();

        assert_eq!(
            sonari_tee_core::to_hex(&bytes),
            "0x16534f4e4152495f464c4f4f525f43454e5355535f56310663656e7375730100000000000000111111111111111111111111111111111111111111111111111111111111111101000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa036400000000000000c8000000000000002c0100000000000000505c18a3010000",
        );
    }

    #[test]
    fn bcs_rejects_wrong_contract_constants() {
        let mut wrong_intent = valid_result();
        wrong_intent.intent = "SONARI_OTHER".to_owned();
        assert!(payload_bcs_bytes(&wrong_intent).is_err());

        let mut wrong_family = valid_result();
        wrong_family.verifier_family = "other".to_owned();
        assert!(payload_bcs_bytes(&wrong_family).is_err());

        let mut wrong_version = valid_result();
        wrong_version.verifier_version = 2;
        assert!(payload_bcs_bytes(&wrong_version).is_err());
    }

    #[test]
    fn bcs_rejects_invalid_bytes32() {
        let mut result = valid_result();
        result.event_uid = "0x11".to_owned();
        assert!(payload_bcs_bytes(&result).is_err());

        let mut result = valid_result();
        result.affected_cells_root = "0xaa".to_owned();
        assert!(payload_bcs_bytes(&result).is_err());
    }

    #[test]
    fn bcs_rejects_invalid_band_count() {
        let mut result = valid_result();
        result.registered_members_by_band = vec![100, 200];

        assert!(payload_bcs_bytes(&result).is_err());
    }
}
