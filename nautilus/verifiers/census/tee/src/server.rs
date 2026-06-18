use crate::encoding::census_bcs::payload_bcs_bytes;
use crate::graphql::CensusGraphqlClient;
use crate::{
    CensusError, CensusInputBundle, CensusResolvedSnapshot, VERIFIER_CONFIG_KEY,
    process_floor_census_input_bundle, validate_census_input_bundle_context,
};
use serde::Deserialize;
use sonari_tee_core::{
    EnclaveRegistrationMetadata, HandlerError, PayloadSigner, ProcessDataHandler, ProcessOutput,
    TeeContext, to_hex,
};

const PROCESS_DATA_ACTION: &str = "process_data";

#[derive(Clone, Copy, Debug, Default)]
pub struct CensusProcessHandler;

impl ProcessDataHandler for CensusProcessHandler {
    fn process(&self, input: &[u8], ctx: &TeeContext) -> Result<ProcessOutput, HandlerError> {
        process_with_resolver(input, ctx, &GraphqlCensusSnapshotResolver)
    }
}

pub trait CensusSnapshotResolver {
    fn resolve_snapshot(
        &self,
        bundle: &CensusInputBundle,
        ctx: &TeeContext,
    ) -> Result<CensusResolvedSnapshot, CensusError>;
}

#[derive(Clone, Debug)]
pub struct CensusProcessHandlerWithResolver<R> {
    resolver: R,
}

impl<R> CensusProcessHandlerWithResolver<R> {
    pub fn new(resolver: R) -> Self {
        Self { resolver }
    }
}

impl<R: CensusSnapshotResolver> ProcessDataHandler for CensusProcessHandlerWithResolver<R> {
    fn process(&self, input: &[u8], ctx: &TeeContext) -> Result<ProcessOutput, HandlerError> {
        process_with_resolver(input, ctx, &self.resolver)
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct GraphqlCensusSnapshotResolver;

impl CensusSnapshotResolver for GraphqlCensusSnapshotResolver {
    fn resolve_snapshot(
        &self,
        bundle: &CensusInputBundle,
        ctx: &TeeContext,
    ) -> Result<CensusResolvedSnapshot, CensusError> {
        let graphql = CensusGraphqlClient::from_context(ctx)
            .map_err(|error| CensusError::InvalidPayload(error.to_string()))?;
        graphql.resolve_counted_cells(bundle)
    }
}

fn process_with_resolver<R: CensusSnapshotResolver>(
    input: &[u8],
    ctx: &TeeContext,
    resolver: &R,
) -> Result<ProcessOutput, HandlerError> {
    let bundle: CensusInputBundle = serde_json::from_slice(input).map_err(|error| {
        HandlerError::new(
            "CENSUS_PROCESS_FAILED",
            format!("invalid census input: {error}"),
        )
    })?;
    validate_census_input_bundle_context(&bundle)
        .map_err(|error| HandlerError::new("CENSUS_PROCESS_FAILED", error.to_string()))?;
    let snapshot = resolver
        .resolve_snapshot(&bundle, ctx)
        .map_err(|error| HandlerError::new("CENSUS_PROCESS_FAILED", error.to_string()))?;
    let result = process_floor_census_input_bundle(&bundle, snapshot)
        .map_err(|error| HandlerError::new("CENSUS_PROCESS_FAILED", error.to_string()))?;
    let payload_bcs = payload_bcs_bytes(&result)
        .map_err(|error| HandlerError::new("CENSUS_PROCESS_FAILED", error.to_string()))?;
    if payload_bcs.is_empty() {
        return Err(HandlerError::new(
            "CENSUS_PROCESS_FAILED",
            "payload_bcs must not be empty",
        ));
    }

    Ok(ProcessOutput::signable(
        payload_bcs.clone(),
        census_result_json(&result, &payload_bcs, "", ""),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessDataEnvelope {
    pub action: String,
    pub payload: serde_json::Value,
    pub registration_metadata: EnclaveRegistrationMetadata,
}

pub fn parse_process_data_envelope(
    body: &[u8],
) -> Result<ProcessDataEnvelope, Box<dyn std::error::Error>> {
    let envelope: ProcessDataEnvelope = serde_json::from_slice(body)?;
    if envelope.action != PROCESS_DATA_ACTION {
        return Err(format!(
            "unexpected /process_data action `{}`; expected `{PROCESS_DATA_ACTION}`",
            envelope.action
        )
        .into());
    }
    verify_census_config_key(&envelope.registration_metadata)?;
    Ok(envelope)
}

pub fn verify_census_config_key(
    metadata: &EnclaveRegistrationMetadata,
) -> Result<(), Box<dyn std::error::Error>> {
    let config_key = metadata.verifier_config_key;
    if config_key != VERIFIER_CONFIG_KEY {
        return Err(format!(
            "registration metadata verifier_config_key {config_key} does not match the census \
             family key {VERIFIER_CONFIG_KEY}"
        )
        .into());
    }
    Ok(())
}

pub fn finalize_process_output<S: PayloadSigner>(
    output: ProcessOutput,
    signer: &S,
    registration_metadata: Option<EnclaveRegistrationMetadata>,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    match output {
        ProcessOutput::Unsigned { result_json } => Ok(result_json),
        ProcessOutput::Signable {
            payload_bcs,
            mut result_json,
        } => {
            if payload_bcs.is_empty() {
                return Err(
                    "signable process output must carry non-empty BCS payload to sign".into(),
                );
            }
            let object = result_json
                .as_object_mut()
                .ok_or("signable process output result must be a JSON object")?;
            let signature = signer.sign_payload(&payload_bcs);
            object.insert(
                "signature".to_owned(),
                serde_json::Value::String(signature.signature),
            );
            object.insert(
                "public_key".to_owned(),
                serde_json::Value::String(signature.public_key),
            );
            if let Some(metadata) = registration_metadata {
                object.insert(
                    "verifier_config_key".to_owned(),
                    serde_json::Value::from(metadata.verifier_config_key),
                );
                object.insert(
                    "verifier_config_version".to_owned(),
                    serde_json::Value::from(metadata.verifier_config_version),
                );
                object.insert(
                    "enclave_instance_public_key".to_owned(),
                    serde_json::Value::String(metadata.enclave_instance_public_key),
                );
            }
            Ok(result_json)
        }
    }
}

pub fn census_result_json(
    payload: &crate::FloorCensusResult,
    payload_bcs: &[u8],
    signature: &str,
    public_key: &str,
) -> serde_json::Value {
    serde_json::json!({
        "status": "finalized",
        "payload": {
            "intent": payload.intent,
            "verifier_family": payload.verifier_family,
            "verifier_version": payload.verifier_version,
            "event_uid": payload.event_uid,
            "event_revision": payload.event_revision,
            "affected_cells_root": payload.affected_cells_root,
            "membership_registry_id": payload.membership_registry_id,
            "cell_count_index_id": payload.cell_count_index_id,
            "census_checkpoint": payload.census_checkpoint,
            "h3_resolution": payload.h3_resolution,
            "shard_count": payload.shard_count,
            "registered_members_by_band": payload.registered_members_by_band,
            "counted_cells_root": payload.counted_cells_root,
            "issued_at_ms": payload.issued_at_ms,
        },
        "payload_bcs_hex": to_hex(payload_bcs),
        "signature": signature,
        "public_key": public_key,
    })
}
