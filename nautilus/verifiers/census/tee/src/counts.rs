use crate::{
    AffectedCellsArtifact, CensusError, FloorCensusResult, INTENT, VERIFIER_FAMILY,
    VERIFIER_VERSION, validate_affected_cells_root,
};
use base64ct::{Base64, Encoding};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::collections::{HashMap, HashSet};
use sui_crypto::bls12381::ValidatorCommitteeSignatureVerifier;
use sui_sdk_types::{
    Address, CheckpointCommitment, CheckpointSummary, Digest, Object, ValidatorAggregatedSignature,
    ValidatorCommittee, hash::Hasher,
};

pub const TRUSTED_VALIDATOR_COMMITTEE_DIGEST_ENV: &str =
    "SONARI_CENSUS_TRUSTED_VALIDATOR_COMMITTEE_DIGEST";

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CensusInputBundle {
    pub event_uid: String,
    pub event_revision: u32,
    pub occurred_at_ms: u64,
    pub affected_cells_root: String,
    pub issued_at_ms: u64,
    pub campaign_id: String,
    pub disaster_event_id: String,
    pub membership_registry_id: String,
    pub census_checkpoint: u64,
    pub affected_cells: AffectedCellsArtifact,
    pub home_cell_events: Vec<HomeCellRegisteredEvent>,
    pub active_lineages: Vec<String>,
    pub authenticated_event_proof: AuthenticatedEventProofBundle,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HomeCellRegisteredEvent {
    pub lineage: String,
    pub home_cell: String,
    pub registered_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AuthenticatedEventProofBundle {
    pub protocol: String,
    pub stream_id: String,
    pub event_stream_head_object_id: String,
    pub start_checkpoint: u64,
    pub end_checkpoint: u64,
    pub highest_indexed_checkpoint: u64,
    pub validator_committee_bcs: String,
    pub checkpoint_summary_bcs: String,
    pub checkpoint_signature_bcs: String,
    pub event_stream_head: EventStreamHeadProofObject,
    pub ocs_proof: ObjectInclusionProof,
    pub events: Vec<AuthenticatedStreamEvent>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EventStreamHeadProofObject {
    pub object_id: String,
    pub version: String,
    pub digest: String,
    pub object_bcs: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ObjectInclusionProof {
    pub leaf_index: u64,
    pub tree_root: String,
    pub merkle_proof: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AuthenticatedStreamEvent {
    pub checkpoint: u64,
    pub transaction_index: u64,
    pub event_index: u64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub event_bcs: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
struct MembershipPassIssuedEventBcs {
    registry_id: Address,
    pass_id: Address,
    owner: Address,
    pass_lineage_id: Address,
    issued_at_ms: u64,
    actor: Address,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
struct HomeCellRegisteredEventBcs {
    lineage: Address,
    home_cell: u64,
    registered_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ReplayedMembershipEvents {
    active_lineages: HashSet<String>,
    home_cell_events: Vec<HomeCellRegisteredEvent>,
}

pub fn compute_floor_census_counts(bundle: &CensusInputBundle) -> Result<[u64; 3], CensusError> {
    validate_affected_cells_root(
        &bundle.event_uid,
        bundle.event_revision,
        &bundle.affected_cells_root,
        &bundle.affected_cells,
    )?;

    let active_lineages = active_lineage_set(&bundle.active_lineages)?;
    let affected_cells = affected_cells_by_h3(&bundle.affected_cells)?;
    let latest_events = latest_pre_cutoff_events(&bundle.home_cell_events, bundle.occurred_at_ms)?;

    let mut counts = [0_u64; 3];
    for (lineage, event) in latest_events {
        if !active_lineages.contains(&lineage) {
            continue;
        }
        let home_cell = parse_canonical_u64_decimal(&event.home_cell, "home_cell")?;
        let Some(band) = affected_cells.get(&home_cell) else {
            continue;
        };
        let index = usize::from(*band - 1);
        counts[index] = counts[index]
            .checked_add(1)
            .ok_or_else(|| CensusError::InvalidPayload("census count overflow".to_owned()))?;
    }

    Ok(counts)
}

pub fn process_floor_census_bundle(
    bundle: &CensusInputBundle,
) -> Result<FloorCensusResult, CensusError> {
    validate_census_context(bundle, None)?;
    process_validated_floor_census_bundle(bundle)
}

pub fn process_floor_census_bundle_with_trust(
    bundle: &CensusInputBundle,
    trusted_validator_committee_digest: &str,
) -> Result<FloorCensusResult, CensusError> {
    validate_census_context(bundle, Some(trusted_validator_committee_digest))?;
    process_validated_floor_census_bundle(bundle)
}

fn process_validated_floor_census_bundle(
    bundle: &CensusInputBundle,
) -> Result<FloorCensusResult, CensusError> {
    let counts = compute_floor_census_counts(bundle)?;

    Ok(FloorCensusResult {
        intent: INTENT.to_owned(),
        verifier_family: VERIFIER_FAMILY.to_owned(),
        verifier_version: VERIFIER_VERSION,
        event_uid: bundle.event_uid.clone(),
        event_revision: bundle.event_revision,
        affected_cells_root: bundle.affected_cells_root.clone(),
        registered_members_by_band: counts.to_vec(),
        issued_at_ms: bundle.issued_at_ms,
    })
}

fn validate_census_context(
    bundle: &CensusInputBundle,
    trusted_validator_committee_digest: Option<&str>,
) -> Result<(), CensusError> {
    validate_object_id(&bundle.campaign_id, "campaign_id")?;
    validate_object_id(&bundle.disaster_event_id, "disaster_event_id")?;
    let membership_registry_id =
        parse_sui_address(&bundle.membership_registry_id, "membership_registry_id")?;
    validate_authenticated_event_proof(
        &bundle.authenticated_event_proof,
        bundle.census_checkpoint,
        trusted_validator_committee_digest,
    )?;
    validate_replayed_membership_events(bundle, membership_registry_id)?;
    Ok(())
}

fn validate_authenticated_event_proof(
    proof: &AuthenticatedEventProofBundle,
    census_checkpoint: u64,
    trusted_validator_committee_digest: Option<&str>,
) -> Result<(), CensusError> {
    if proof.protocol != "sui-authenticated-events-v1" {
        return Err(CensusError::InvalidPayload(
            "authenticated_event_proof.protocol must be sui-authenticated-events-v1".to_owned(),
        ));
    }
    validate_object_id(&proof.stream_id, "authenticated_event_proof.stream_id")?;
    validate_object_id(
        &proof.event_stream_head_object_id,
        "authenticated_event_proof.event_stream_head_object_id",
    )?;
    validate_object_id(
        &proof.event_stream_head.object_id,
        "authenticated_event_proof.event_stream_head.object_id",
    )?;
    if proof.event_stream_head.object_id != proof.event_stream_head_object_id {
        return Err(CensusError::InvalidPayload(
            "authenticated_event_proof EventStreamHead object id mismatch".to_owned(),
        ));
    }
    let event_stream_head_digest = parse_sui_digest(
        &proof.event_stream_head.digest,
        "authenticated_event_proof.event_stream_head.digest",
    )?;
    let tree_root = parse_sui_digest(
        &proof.ocs_proof.tree_root,
        "authenticated_event_proof.ocs_proof.tree_root",
    )?;
    parse_canonical_u64_decimal(
        &proof.event_stream_head.version,
        "authenticated_event_proof.event_stream_head.version",
    )?;
    let validator_committee_bcs = decode_base64(
        &proof.validator_committee_bcs,
        "authenticated_event_proof.validator_committee_bcs",
    )?;
    let checkpoint_summary_bcs = decode_base64(
        &proof.checkpoint_summary_bcs,
        "authenticated_event_proof.checkpoint_summary_bcs",
    )?;
    let checkpoint_signature_bcs = decode_base64(
        &proof.checkpoint_signature_bcs,
        "authenticated_event_proof.checkpoint_signature_bcs",
    )?;
    let event_stream_head_object_bcs = decode_base64(
        &proof.event_stream_head.object_bcs,
        "authenticated_event_proof.event_stream_head.object_bcs",
    )?;
    for (index, proof_node) in proof.ocs_proof.merkle_proof.iter().enumerate() {
        validate_base64(
            proof_node,
            &format!("authenticated_event_proof.ocs_proof.merkle_proof[{index}]"),
        )?;
    }
    if proof.start_checkpoint > proof.end_checkpoint {
        return Err(CensusError::InvalidPayload(
            "authenticated_event_proof.start_checkpoint must be <= end_checkpoint".to_owned(),
        ));
    }
    if proof.end_checkpoint > census_checkpoint {
        return Err(CensusError::InvalidPayload(
            "authenticated_event_proof.end_checkpoint must be <= census_checkpoint".to_owned(),
        ));
    }
    if proof.highest_indexed_checkpoint < proof.end_checkpoint {
        return Err(CensusError::InvalidPayload(
            "authenticated_event_proof.highest_indexed_checkpoint is behind end_checkpoint"
                .to_owned(),
        ));
    }

    verify_checkpoint_signature_and_head(
        proof,
        &validator_committee_bcs,
        &checkpoint_summary_bcs,
        &checkpoint_signature_bcs,
        &event_stream_head_object_bcs,
        event_stream_head_digest,
        tree_root,
        trusted_validator_committee_digest,
    )?;

    let mut last_position: Option<(u64, u64, u64)> = None;
    for event in &proof.events {
        if event.checkpoint < proof.start_checkpoint || event.checkpoint > proof.end_checkpoint {
            return Err(CensusError::InvalidPayload(
                "authenticated_event_proof event checkpoint is outside proof range".to_owned(),
            ));
        }
        if event.event_type.is_empty() {
            return Err(CensusError::InvalidPayload(
                "authenticated_event_proof event type must not be empty".to_owned(),
            ));
        }
        validate_base64(
            &event.event_bcs,
            "authenticated_event_proof event event_bcs",
        )?;
        let position = (event.checkpoint, event.transaction_index, event.event_index);
        if last_position.is_some_and(|last| last >= position) {
            return Err(CensusError::InvalidPayload(
                "authenticated_event_proof events must be strictly ordered".to_owned(),
            ));
        }
        last_position = Some(position);
    }
    Ok(())
}

fn validate_replayed_membership_events(
    bundle: &CensusInputBundle,
    membership_registry_id: Address,
) -> Result<(), CensusError> {
    let replayed =
        replay_membership_events(&bundle.authenticated_event_proof, membership_registry_id)?;
    let bundle_active = active_lineage_set(&bundle.active_lineages)?;
    if bundle_active != replayed.active_lineages {
        return Err(CensusError::InvalidPayload(
            "authenticated_event_proof replayed active lineages do not match bundle active_lineages"
                .to_owned(),
        ));
    }
    if bundle.home_cell_events != replayed.home_cell_events {
        return Err(CensusError::InvalidPayload(
            "authenticated_event_proof replayed home cell events do not match bundle home_cell_events"
                .to_owned(),
        ));
    }
    Ok(())
}

fn replay_membership_events(
    proof: &AuthenticatedEventProofBundle,
    membership_registry_id: Address,
) -> Result<ReplayedMembershipEvents, CensusError> {
    let expected_prefix = format!("{}::membership::", proof.stream_id);
    let issued_type = format!("{expected_prefix}MembershipPassIssued");
    let home_cell_type = format!("{expected_prefix}HomeCellRegistered");
    let mut active_lineages = HashSet::new();
    let mut home_cell_events = Vec::new();

    for event in &proof.events {
        if !event.event_type.starts_with(&expected_prefix) {
            return Err(CensusError::InvalidPayload(
                "authenticated_event_proof event type does not belong to stream package".to_owned(),
            ));
        }
        let event_bcs = decode_base64(
            &event.event_bcs,
            "authenticated_event_proof event event_bcs",
        )?;
        if event.event_type == issued_type {
            let issued: MembershipPassIssuedEventBcs = decode_bcs(
                &event_bcs,
                "authenticated_event_proof MembershipPassIssued event_bcs",
            )?;
            if issued.registry_id == membership_registry_id {
                active_lineages.insert(issued.pass_lineage_id.to_hex());
            }
        } else if event.event_type == home_cell_type {
            let home_cell: HomeCellRegisteredEventBcs = decode_bcs(
                &event_bcs,
                "authenticated_event_proof HomeCellRegistered event_bcs",
            )?;
            home_cell_events.push(HomeCellRegisteredEvent {
                lineage: home_cell.lineage.to_hex(),
                home_cell: home_cell.home_cell.to_string(),
                registered_at_ms: home_cell.registered_at,
            });
        } else {
            return Err(CensusError::InvalidPayload(format!(
                "authenticated_event_proof unsupported authenticated event type `{}`",
                event.event_type
            )));
        }
    }

    Ok(ReplayedMembershipEvents {
        active_lineages,
        home_cell_events,
    })
}

#[allow(clippy::too_many_arguments)]
fn verify_checkpoint_signature_and_head(
    proof: &AuthenticatedEventProofBundle,
    validator_committee_bcs: &[u8],
    checkpoint_summary_bcs: &[u8],
    checkpoint_signature_bcs: &[u8],
    event_stream_head_object_bcs: &[u8],
    event_stream_head_digest: Digest,
    tree_root: Digest,
    trusted_validator_committee_digest: Option<&str>,
) -> Result<(), CensusError> {
    let committee: ValidatorCommittee = decode_bcs(
        validator_committee_bcs,
        "authenticated_event_proof.validator_committee_bcs",
    )?;
    let summary: CheckpointSummary = decode_bcs(
        checkpoint_summary_bcs,
        "authenticated_event_proof.checkpoint_summary_bcs",
    )?;
    let signature: ValidatorAggregatedSignature = decode_bcs(
        checkpoint_signature_bcs,
        "authenticated_event_proof.checkpoint_signature_bcs",
    )?;

    if let Some(trusted_digest) = trusted_validator_committee_digest {
        let expected = parse_sui_digest(trusted_digest, TRUSTED_VALIDATOR_COMMITTEE_DIGEST_ENV)?;
        let actual = validator_committee_digest(validator_committee_bcs);
        if actual != expected {
            return Err(CensusError::InvalidPayload(
                "authenticated_event_proof validator committee does not match trusted digest"
                    .to_owned(),
            ));
        }
    }

    if committee.epoch != summary.epoch {
        return Err(CensusError::InvalidPayload(
            "authenticated_event_proof validator committee epoch does not match checkpoint summary"
                .to_owned(),
        ));
    }
    if summary.sequence_number != proof.end_checkpoint {
        return Err(CensusError::InvalidPayload(
            "authenticated_event_proof checkpoint summary sequence_number must equal end_checkpoint"
                .to_owned(),
        ));
    }
    if !summary
        .checkpoint_commitments
        .iter()
        .any(|commitment| matches!(commitment, CheckpointCommitment::EcmhLiveObjectSet { digest } if *digest == tree_root))
    {
        return Err(CensusError::InvalidPayload(
            "authenticated_event_proof OCS tree_root is not committed by checkpoint summary"
                .to_owned(),
        ));
    }

    let verifier = ValidatorCommitteeSignatureVerifier::new(committee).map_err(|error| {
        CensusError::InvalidPayload(format!(
            "authenticated_event_proof validator committee is invalid: {error}"
        ))
    })?;
    verifier
        .verify_checkpoint_summary(&summary, &signature)
        .map_err(|error| {
            CensusError::InvalidPayload(format!(
                "authenticated_event_proof checkpoint signature is invalid: {error}"
            ))
        })?;

    let event_stream_head: Object = decode_bcs(
        event_stream_head_object_bcs,
        "authenticated_event_proof.event_stream_head.object_bcs",
    )?;
    let expected_object_id = parse_sui_address(
        &proof.event_stream_head_object_id,
        "authenticated_event_proof.event_stream_head_object_id",
    )?;
    if event_stream_head.object_id() != expected_object_id {
        return Err(CensusError::InvalidPayload(
            "authenticated_event_proof EventStreamHead object_bcs object id mismatch".to_owned(),
        ));
    }
    if event_stream_head.version().to_string() != proof.event_stream_head.version {
        return Err(CensusError::InvalidPayload(
            "authenticated_event_proof EventStreamHead object_bcs version mismatch".to_owned(),
        ));
    }
    if event_stream_head.digest() != event_stream_head_digest {
        return Err(CensusError::InvalidPayload(
            "authenticated_event_proof EventStreamHead object digest mismatch".to_owned(),
        ));
    }

    Ok(())
}

pub fn validator_committee_digest(validator_committee_bcs: &[u8]) -> Digest {
    let mut hasher = Hasher::new();
    hasher.update(b"SonariCensusValidatorCommittee::");
    hasher.update(validator_committee_bcs);
    hasher.finalize()
}

fn active_lineage_set(lineages: &[String]) -> Result<HashSet<String>, CensusError> {
    let mut active = HashSet::with_capacity(lineages.len());
    for lineage in lineages {
        validate_lineage(lineage)?;
        active.insert(lineage.clone());
    }
    Ok(active)
}

fn affected_cells_by_h3(artifact: &AffectedCellsArtifact) -> Result<HashMap<u64, u8>, CensusError> {
    let mut cells = HashMap::with_capacity(artifact.affected_cells.len());
    for cell in &artifact.affected_cells {
        let h3_index = parse_canonical_u64_decimal(&cell.h3_index, "h3_index")?;
        let band = u8::try_from(cell.cell_band).map_err(|_| {
            CensusError::InvalidPayload(format!(
                "cell_band must be in 1..=3, got {}",
                cell.cell_band
            ))
        })?;
        if !(1..=3).contains(&band) {
            return Err(CensusError::InvalidPayload(format!(
                "cell_band must be in 1..=3, got {band}"
            )));
        }
        cells.insert(h3_index, band);
    }
    Ok(cells)
}

fn latest_pre_cutoff_events(
    events: &[HomeCellRegisteredEvent],
    cutoff_ms: u64,
) -> Result<HashMap<String, HomeCellRegisteredEvent>, CensusError> {
    let mut latest = HashMap::new();
    for event in events {
        validate_lineage(&event.lineage)?;
        parse_canonical_u64_decimal(&event.home_cell, "home_cell")?;
        if event.registered_at_ms >= cutoff_ms {
            continue;
        }

        latest
            .entry(event.lineage.clone())
            .and_modify(|previous: &mut HomeCellRegisteredEvent| {
                if previous.registered_at_ms <= event.registered_at_ms {
                    *previous = event.clone();
                }
            })
            .or_insert_with(|| event.clone());
    }
    Ok(latest)
}

fn validate_lineage(value: &str) -> Result<(), CensusError> {
    if !value.starts_with("0x") {
        return Err(CensusError::InvalidPayload(
            "lineage must be 0x-prefixed 32-byte hex".to_owned(),
        ));
    }
    sonari_tee_core::hex_to_32(value)?;
    Ok(())
}

fn validate_object_id(value: &str, field: &str) -> Result<(), CensusError> {
    if !value.starts_with("0x") {
        return Err(CensusError::InvalidPayload(format!(
            "{field} must be 0x-prefixed 32-byte hex"
        )));
    }
    sonari_tee_core::hex_to_32(value)?;
    Ok(())
}

fn parse_sui_address(value: &str, field: &str) -> Result<Address, CensusError> {
    validate_object_id(value, field)?;
    let bytes = sonari_tee_core::hex_to_32(value)?;
    Address::from_bytes(bytes).map_err(|error| {
        CensusError::InvalidPayload(format!("{field} must be a Sui address: {error}"))
    })
}

fn parse_sui_digest(value: &str, field: &str) -> Result<Digest, CensusError> {
    Digest::from_base58(value).map_err(|error| {
        CensusError::InvalidPayload(format!("{field} must be a Sui base58 digest: {error}"))
    })
}

fn parse_canonical_u64_decimal(value: &str, field: &str) -> Result<u64, CensusError> {
    if value.is_empty() {
        return Err(CensusError::InvalidPayload(format!(
            "{field} must not be empty"
        )));
    }
    if value != "0" && value.starts_with('0') {
        return Err(CensusError::InvalidPayload(format!(
            "{field} must be canonical decimal without leading zeros"
        )));
    }
    if !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(CensusError::InvalidPayload(format!(
            "{field} must be a decimal u64 string"
        )));
    }
    value
        .parse::<u64>()
        .map_err(|_| CensusError::InvalidPayload(format!("{field} must be a decimal u64 string")))
}

fn decode_base64(value: &str, field: &str) -> Result<Vec<u8>, CensusError> {
    Base64::decode_vec(value)
        .map_err(|_| CensusError::InvalidPayload(format!("{field} must be base64-encoded bytes")))
}

fn decode_bcs<T: DeserializeOwned>(bytes: &[u8], field: &str) -> Result<T, CensusError> {
    bcs::from_bytes(bytes)
        .map_err(|error| CensusError::InvalidPayload(format!("{field} must be valid BCS: {error}")))
}

fn validate_base64(value: &str, field: &str) -> Result<(), CensusError> {
    decode_base64(value, field).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::{
        AuthenticatedEventProofBundle, AuthenticatedStreamEvent, CensusInputBundle,
        EventStreamHeadProofObject, HomeCellRegisteredEvent, HomeCellRegisteredEventBcs,
        MembershipPassIssuedEventBcs, ObjectInclusionProof, validator_committee_digest,
    };
    use crate::{
        AffectedCell, AffectedCellsArtifact, INTENT, VERIFIER_FAMILY, VERIFIER_VERSION,
        compute_affected_cells_root, compute_floor_census_counts, process_floor_census_bundle,
        process_floor_census_bundle_with_trust,
    };
    use base64ct::{Base64, Encoding};
    use sui_crypto::bls12381::{Bls12381PrivateKey, ValidatorCommitteeSignatureAggregator};
    use sui_sdk_types::{
        Address, CheckpointCommitment, CheckpointSummary, Digest, GasCostSummary, Identifier,
        MoveStruct, Object, ObjectData, Owner, StructTag, ValidatorCommittee,
        ValidatorCommitteeMember,
    };

    const EVENT_UID: &str = "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd";
    const ACTIVE_1: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const ACTIVE_2: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";
    const ACTIVE_3: &str = "0x3333333333333333333333333333333333333333333333333333333333333333";
    const INACTIVE: &str = "0x4444444444444444444444444444444444444444444444444444444444444444";
    const MEMBERSHIP_REGISTRY_ID: &str =
        "0x7777777777777777777777777777777777777777777777777777777777777777";

    fn affected_cells() -> AffectedCellsArtifact {
        AffectedCellsArtifact {
            event_uid: EVENT_UID.to_owned(),
            event_revision: 7,
            oracle_version: 1,
            geo_resolution: 7,
            cells_generation_method: "shakemap_gridxml_h3_grid_point_p90_v1".to_owned(),
            cell_metric: "USGS_MMI".to_owned(),
            cell_aggregation: "GRID_POINT_P90".to_owned(),
            intensity_scale: "MMI_X100".to_owned(),
            affected_cells: vec![
                AffectedCell {
                    h3_index: "10".to_owned(),
                    intensity_value: 600,
                    cell_band: 1,
                },
                AffectedCell {
                    h3_index: "20".to_owned(),
                    intensity_value: 700,
                    cell_band: 2,
                },
                AffectedCell {
                    h3_index: "30".to_owned(),
                    intensity_value: 800,
                    cell_band: 3,
                },
            ],
        }
    }

    fn valid_bundle() -> CensusInputBundle {
        let affected_cells = affected_cells();
        let affected_cells_root =
            compute_affected_cells_root(EVENT_UID, 7, &affected_cells).unwrap();
        CensusInputBundle {
            event_uid: EVENT_UID.to_owned(),
            event_revision: 7,
            occurred_at_ms: 1_000,
            affected_cells_root,
            issued_at_ms: 1_234,
            campaign_id: format!("0x{}", "55".repeat(32)),
            disaster_event_id: format!("0x{}", "66".repeat(32)),
            membership_registry_id: MEMBERSHIP_REGISTRY_ID.to_owned(),
            census_checkpoint: 345,
            affected_cells,
            home_cell_events: Vec::new(),
            active_lineages: vec![
                ACTIVE_1.to_owned(),
                ACTIVE_2.to_owned(),
                ACTIVE_3.to_owned(),
            ],
            authenticated_event_proof: authenticated_event_proof(),
        }
    }

    fn authenticated_event_proof() -> AuthenticatedEventProofBundle {
        let fixture = authenticated_checkpoint_fixture(345, Digest::new([0x78; 32]));
        AuthenticatedEventProofBundle {
            protocol: "sui-authenticated-events-v1".to_owned(),
            stream_id: format!("0x{}", "12".repeat(32)),
            event_stream_head_object_id: format!("0x{}", "34".repeat(32)),
            start_checkpoint: 0,
            end_checkpoint: 345,
            highest_indexed_checkpoint: 345,
            validator_committee_bcs: fixture.validator_committee_bcs,
            checkpoint_summary_bcs: fixture.checkpoint_summary_bcs,
            checkpoint_signature_bcs: fixture.checkpoint_signature_bcs,
            event_stream_head: EventStreamHeadProofObject {
                object_id: format!("0x{}", "34".repeat(32)),
                version: "7".to_owned(),
                digest: fixture.event_stream_head_digest,
                object_bcs: fixture.event_stream_head_object_bcs,
            },
            ocs_proof: ObjectInclusionProof {
                leaf_index: 3,
                tree_root: fixture.tree_root,
                merkle_proof: vec!["cHJvb2YtMQ==".to_owned()],
            },
            events: default_membership_pass_issued_events(),
        }
    }

    fn default_membership_pass_issued_events() -> Vec<AuthenticatedStreamEvent> {
        [ACTIVE_1, ACTIVE_2, ACTIVE_3]
            .into_iter()
            .enumerate()
            .map(|(index, lineage)| membership_pass_issued_event(index as u64, lineage))
            .collect()
    }

    fn sync_proof_home_cell_events(bundle: &mut CensusInputBundle) {
        let mut events = default_membership_pass_issued_events();
        events.extend(
            bundle
                .home_cell_events
                .iter()
                .enumerate()
                .map(|(index, event)| home_cell_registered_stream_event(index as u64, event)),
        );
        bundle.authenticated_event_proof.events = events;
    }

    fn membership_pass_issued_event(index: u64, lineage: &str) -> AuthenticatedStreamEvent {
        let event = MembershipPassIssuedEventBcs {
            registry_id: address(MEMBERSHIP_REGISTRY_ID),
            pass_id: Address::new([0x90_u8.saturating_add(index as u8); 32]),
            owner: Address::new([0xa0_u8.saturating_add(index as u8); 32]),
            pass_lineage_id: address(lineage),
            issued_at_ms: 100 + index,
            actor: Address::new([0xb0_u8.saturating_add(index as u8); 32]),
        };
        AuthenticatedStreamEvent {
            checkpoint: 10 + index,
            transaction_index: 0,
            event_index: index,
            event_type: format!("0x{}::membership::MembershipPassIssued", "12".repeat(32)),
            event_bcs: Base64::encode_string(&bcs::to_bytes(&event).unwrap()),
        }
    }

    fn home_cell_registered_stream_event(
        index: u64,
        event: &HomeCellRegisteredEvent,
    ) -> AuthenticatedStreamEvent {
        let event_bcs = HomeCellRegisteredEventBcs {
            lineage: address(&event.lineage),
            home_cell: event.home_cell.parse().unwrap(),
            registered_at: event.registered_at_ms,
        };
        AuthenticatedStreamEvent {
            checkpoint: 100 + index,
            transaction_index: 0,
            event_index: index,
            event_type: format!("0x{}::membership::HomeCellRegistered", "12".repeat(32)),
            event_bcs: Base64::encode_string(&bcs::to_bytes(&event_bcs).unwrap()),
        }
    }

    fn address(value: &str) -> Address {
        Address::from_hex(value).unwrap()
    }

    struct AuthenticatedCheckpointFixture {
        validator_committee_bcs: String,
        checkpoint_summary_bcs: String,
        checkpoint_signature_bcs: String,
        event_stream_head_digest: String,
        event_stream_head_object_bcs: String,
        tree_root: String,
    }

    fn authenticated_checkpoint_fixture(
        sequence_number: u64,
        tree_root: Digest,
    ) -> AuthenticatedCheckpointFixture {
        let object_id = Address::new([0x34; 32]);
        let mut contents = object_id.into_inner().to_vec();
        contents.extend_from_slice(b"event-stream-head");
        let move_struct = MoveStruct::new(
            StructTag::new(
                Address::new([0x12; 32]),
                Identifier::from_static("authenticated_event"),
                Identifier::from_static("EventStreamHead"),
                Vec::new(),
            ),
            false,
            7,
            contents,
        )
        .unwrap();
        let event_stream_head = Object::new(
            ObjectData::Struct(move_struct),
            Owner::Shared(1),
            Digest::new([0x99; 32]),
            0,
        );

        let summary = CheckpointSummary {
            epoch: 22,
            sequence_number,
            network_total_transactions: 123,
            content_digest: Digest::new([0x41; 32]),
            previous_digest: Some(Digest::new([0x42; 32])),
            epoch_rolling_gas_cost_summary: GasCostSummary::new(0, 0, 0, 0),
            timestamp_ms: 1_700_000_000_000,
            checkpoint_commitments: vec![CheckpointCommitment::EcmhLiveObjectSet {
                digest: tree_root,
            }],
            end_of_epoch_data: None,
            version_specific_data: Vec::new(),
        };
        let private_keys = [
            Bls12381PrivateKey::new([1; 32]).unwrap(),
            Bls12381PrivateKey::new([2; 32]).unwrap(),
            Bls12381PrivateKey::new([3; 32]).unwrap(),
            Bls12381PrivateKey::new([4; 32]).unwrap(),
        ];
        let committee = ValidatorCommittee {
            epoch: summary.epoch,
            members: private_keys
                .iter()
                .map(|key| ValidatorCommitteeMember {
                    public_key: key.public_key(),
                    stake: 1,
                })
                .collect(),
        };
        let mut aggregator = ValidatorCommitteeSignatureAggregator::new_checkpoint_summary(
            committee.clone(),
            &summary,
        )
        .unwrap();
        aggregator
            .add_signature(private_keys[0].sign_checkpoint_summary(&summary))
            .unwrap();
        aggregator
            .add_signature(private_keys[1].sign_checkpoint_summary(&summary))
            .unwrap();
        aggregator
            .add_signature(private_keys[2].sign_checkpoint_summary(&summary))
            .unwrap();
        let signature = aggregator.finish().unwrap();

        AuthenticatedCheckpointFixture {
            validator_committee_bcs: Base64::encode_string(&bcs::to_bytes(&committee).unwrap()),
            checkpoint_summary_bcs: Base64::encode_string(&bcs::to_bytes(&summary).unwrap()),
            checkpoint_signature_bcs: Base64::encode_string(&bcs::to_bytes(&signature).unwrap()),
            event_stream_head_digest: event_stream_head.digest().to_string(),
            event_stream_head_object_bcs: Base64::encode_string(
                &bcs::to_bytes(&event_stream_head).unwrap(),
            ),
            tree_root: tree_root.to_string(),
        }
    }

    fn event(lineage: &str, home_cell: &str, registered_at_ms: u64) -> HomeCellRegisteredEvent {
        HomeCellRegisteredEvent {
            lineage: lineage.to_owned(),
            home_cell: home_cell.to_owned(),
            registered_at_ms,
        }
    }

    #[test]
    fn counts_ignore_home_cell_registrations_at_or_after_cutoff() {
        let mut bundle = valid_bundle();
        bundle.home_cell_events = vec![
            event(ACTIVE_1, "10", 999),
            event(ACTIVE_2, "20", 1_000),
            event(ACTIVE_3, "30", 1_001),
        ];

        assert_eq!(compute_floor_census_counts(&bundle).unwrap(), [1, 0, 0]);
    }

    #[test]
    fn counts_use_latest_pre_cutoff_home_cell_per_lineage() {
        let mut bundle = valid_bundle();
        bundle.home_cell_events = vec![
            event(ACTIVE_1, "10", 800),
            event(ACTIVE_1, "20", 900),
            event(ACTIVE_2, "30", 700),
        ];

        assert_eq!(compute_floor_census_counts(&bundle).unwrap(), [0, 1, 1]);
    }

    #[test]
    fn counts_ignore_inactive_lineages() {
        let mut bundle = valid_bundle();
        bundle.home_cell_events = vec![event(ACTIVE_1, "10", 900), event(INACTIVE, "20", 900)];

        assert_eq!(compute_floor_census_counts(&bundle).unwrap(), [1, 0, 0]);
    }

    #[test]
    fn counts_use_later_event_when_registered_at_matches() {
        let mut bundle = valid_bundle();
        bundle.home_cell_events = vec![event(ACTIVE_1, "10", 900), event(ACTIVE_1, "30", 900)];

        assert_eq!(compute_floor_census_counts(&bundle).unwrap(), [0, 0, 1]);
    }

    #[test]
    fn counts_ignore_home_cells_outside_affected_cells() {
        let mut bundle = valid_bundle();
        bundle.home_cell_events = vec![event(ACTIVE_1, "40", 900), event(ACTIVE_2, "20", 900)];

        assert_eq!(compute_floor_census_counts(&bundle).unwrap(), [0, 1, 0]);
    }

    #[test]
    fn counts_reject_malformed_lineage_home_cell_and_root_mismatch() {
        let mut bundle = valid_bundle();
        bundle.active_lineages = vec!["0x1234".to_owned()];
        assert!(compute_floor_census_counts(&bundle).is_err());

        let mut bundle = valid_bundle();
        bundle.home_cell_events = vec![event("0x1234", "10", 900)];
        assert!(compute_floor_census_counts(&bundle).is_err());

        let mut bundle = valid_bundle();
        bundle.home_cell_events = vec![event(ACTIVE_1, "01", 900)];
        assert!(compute_floor_census_counts(&bundle).is_err());

        let mut bundle = valid_bundle();
        bundle.affected_cells_root =
            "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_owned();
        assert!(compute_floor_census_counts(&bundle).is_err());
    }

    #[test]
    fn process_floor_census_bundle_returns_floor_census_result() {
        let mut bundle = valid_bundle();
        bundle.home_cell_events = vec![
            event(ACTIVE_1, "10", 900),
            event(ACTIVE_2, "20", 900),
            event(ACTIVE_3, "30", 900),
        ];
        sync_proof_home_cell_events(&mut bundle);

        let result = process_floor_census_bundle(&bundle).unwrap();

        assert_eq!(result.intent, INTENT);
        assert_eq!(result.verifier_family, VERIFIER_FAMILY);
        assert_eq!(result.verifier_version, VERIFIER_VERSION);
        assert_eq!(result.event_uid, EVENT_UID);
        assert_eq!(result.event_revision, 7);
        assert_eq!(result.affected_cells_root, bundle.affected_cells_root);
        assert_eq!(result.registered_members_by_band, vec![1, 1, 1]);
        assert_eq!(result.issued_at_ms, 1_234);
    }

    #[test]
    fn process_rejects_malformed_campaign_and_disaster_ids() {
        let mut bundle = valid_bundle();
        bundle.campaign_id = "0x1234".to_owned();
        assert!(process_floor_census_bundle(&bundle).is_err());

        let mut bundle = valid_bundle();
        bundle.disaster_event_id = "0x1234".to_owned();
        assert!(process_floor_census_bundle(&bundle).is_err());
    }

    #[test]
    fn process_rejects_home_cell_snapshot_not_replayed_from_authenticated_events() {
        let mut bundle = valid_bundle();
        bundle.home_cell_events = vec![event(ACTIVE_1, "10", 900)];

        let error = process_floor_census_bundle(&bundle)
            .expect_err("bundle home cell snapshot must match replayed authenticated events");

        assert!(
            error
                .to_string()
                .contains("replayed home cell events do not match")
        );
    }

    #[test]
    fn process_rejects_active_lineage_snapshot_not_replayed_from_authenticated_events() {
        let mut bundle = valid_bundle();
        bundle.active_lineages = vec![ACTIVE_1.to_owned()];

        let error = process_floor_census_bundle(&bundle)
            .expect_err("bundle active lineages must match replayed authenticated events");

        assert!(
            error
                .to_string()
                .contains("replayed active lineages do not match")
        );
    }

    #[test]
    fn process_rejects_unsupported_authenticated_membership_event_type() {
        let mut bundle = valid_bundle();
        bundle.authenticated_event_proof.events[0].event_type =
            format!("0x{}::membership::UnknownEvent", "12".repeat(32));

        let error = process_floor_census_bundle(&bundle)
            .expect_err("unknown authenticated event types must fail closed");

        assert!(
            error
                .to_string()
                .contains("unsupported authenticated event type")
        );
    }

    #[test]
    fn process_ignores_passes_issued_for_other_membership_registry() {
        let mut bundle = valid_bundle();
        let other = MembershipPassIssuedEventBcs {
            registry_id: Address::new([0x88; 32]),
            pass_id: Address::new([0x89; 32]),
            owner: Address::new([0x8a; 32]),
            pass_lineage_id: address(INACTIVE),
            issued_at_ms: 999,
            actor: Address::new([0x8b; 32]),
        };
        bundle
            .authenticated_event_proof
            .events
            .push(AuthenticatedStreamEvent {
                checkpoint: 200,
                transaction_index: 0,
                event_index: 0,
                event_type: format!("0x{}::membership::MembershipPassIssued", "12".repeat(32)),
                event_bcs: Base64::encode_string(&bcs::to_bytes(&other).unwrap()),
            });

        process_floor_census_bundle(&bundle).expect(
            "MembershipPassIssued for another registry should not change active lineage set",
        );
    }

    #[test]
    fn process_rejects_invalid_authenticated_event_context() {
        let mut bundle = valid_bundle();
        bundle.authenticated_event_proof.event_stream_head.object_id =
            format!("0x{}", "99".repeat(32));
        assert!(process_floor_census_bundle(&bundle).is_err());

        let mut bundle = valid_bundle();
        bundle.authenticated_event_proof.highest_indexed_checkpoint = 344;
        assert!(process_floor_census_bundle(&bundle).is_err());

        let mut bundle = valid_bundle();
        bundle
            .authenticated_event_proof
            .events
            .push(AuthenticatedStreamEvent {
                checkpoint: 100,
                transaction_index: 0,
                event_index: 0,
                event_type: format!("0x{}::membership::HomeCellRegistered", "12".repeat(32)),
                event_bcs: "ZXZlbnQtMg==".to_owned(),
            });
        assert!(process_floor_census_bundle(&bundle).is_err());
    }

    #[test]
    fn process_rejects_invalid_checkpoint_signature() {
        let mut bundle = valid_bundle();
        let replacement_signature =
            authenticated_checkpoint_fixture(344, Digest::new([0x78; 32])).checkpoint_signature_bcs;
        bundle.authenticated_event_proof.checkpoint_signature_bcs = replacement_signature;

        let error = process_floor_census_bundle(&bundle)
            .expect_err("checkpoint signature must match checkpoint summary");

        assert!(
            error
                .to_string()
                .contains("checkpoint signature is invalid")
        );
    }

    #[test]
    fn process_with_trust_rejects_untrusted_validator_committee() {
        let bundle = valid_bundle();
        let untrusted_digest = Digest::new([0xaa; 32]).to_string();

        let error = process_floor_census_bundle_with_trust(&bundle, &untrusted_digest)
            .expect_err("validator committee must match trusted digest");

        assert!(
            error
                .to_string()
                .contains("validator committee does not match trusted digest")
        );
    }

    #[test]
    fn process_with_trust_accepts_trusted_validator_committee() {
        let bundle = valid_bundle();
        let committee_bcs =
            Base64::decode_vec(&bundle.authenticated_event_proof.validator_committee_bcs).unwrap();
        let trusted_digest = validator_committee_digest(&committee_bcs).to_string();

        let result = process_floor_census_bundle_with_trust(&bundle, &trusted_digest)
            .expect("trusted committee should be accepted");

        assert_eq!(result.intent, INTENT);
    }

    #[test]
    fn process_rejects_ocs_root_not_committed_by_checkpoint() {
        let mut bundle = valid_bundle();
        bundle.authenticated_event_proof.ocs_proof.tree_root = Digest::new([0x79; 32]).to_string();

        let error = process_floor_census_bundle(&bundle)
            .expect_err("OCS root must be committed by checkpoint summary");

        assert!(error.to_string().contains("OCS tree_root"));
    }

    #[test]
    fn process_rejects_event_stream_head_digest_mismatch() {
        let mut bundle = valid_bundle();
        bundle.authenticated_event_proof.event_stream_head.digest =
            Digest::new([0x56; 32]).to_string();

        let error = process_floor_census_bundle(&bundle)
            .expect_err("EventStreamHead digest must match object BCS");

        assert!(error.to_string().contains("object digest mismatch"));
    }
}
