use crate::CensusError;
use reqwest::Url;
use serde_json::Value;
use sonari_tee_core::TeeContext;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

pub const CENSUS_GRAPHQL_NETWORK_KEY: &str = "SONARI_CENSUS_SUI_NETWORK";
pub const CENSUS_GRAPHQL_EGRESS_PROXY_URL_KEY: &str = "SONARI_CENSUS_GRAPHQL_EGRESS_PROXY_URL";

const GRAPHQL_REQUEST_TIMEOUT_MS: u64 = 10_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SuiGraphqlNetwork {
    Mainnet,
    Testnet,
    Devnet,
    Localnet,
}

impl SuiGraphqlNetwork {
    pub fn parse(value: &str) -> Result<Self, CensusError> {
        match value.trim() {
            "mainnet" => Ok(Self::Mainnet),
            "testnet" => Ok(Self::Testnet),
            "devnet" => Ok(Self::Devnet),
            "localnet" => Ok(Self::Localnet),
            other => Err(CensusError::InvalidPayload(format!(
                "unsupported census GraphQL network `{other}`"
            ))),
        }
    }

    pub fn canonical_graphql_url(&self) -> &'static str {
        match self {
            Self::Mainnet => "https://graphql.mainnet.sui.io/graphql",
            Self::Testnet => "https://graphql.testnet.sui.io/graphql",
            Self::Devnet => "https://graphql.devnet.sui.io/graphql",
            Self::Localnet => "http://127.0.0.1:9125/graphql",
        }
    }
}

#[derive(Debug)]
pub struct CensusGraphqlClient {
    pub endpoint: Url,
    pub http: reqwest::blocking::Client,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CellCountIndexMetadata {
    pub cell_count_index_id: String,
    pub h3_resolution: u8,
    pub shard_count: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CellCountIndexResolution {
    pub census_checkpoint: u64,
    pub index: CellCountIndexMetadata,
    pub shard_object_ids: HashMap<u64, String>,
}

impl CensusGraphqlClient {
    pub fn from_context(ctx: &TeeContext) -> Result<Self, CensusError> {
        let network = ctx
            .get(CENSUS_GRAPHQL_NETWORK_KEY)
            .map(SuiGraphqlNetwork::parse)
            .transpose()?
            .ok_or_else(|| {
                CensusError::InvalidPayload(format!("{CENSUS_GRAPHQL_NETWORK_KEY} is required"))
            })?;
        Self::from_network_and_proxy(network, ctx.get(CENSUS_GRAPHQL_EGRESS_PROXY_URL_KEY))
    }

    pub fn from_network_and_proxy(
        network: SuiGraphqlNetwork,
        egress_proxy_url: Option<&str>,
    ) -> Result<Self, CensusError> {
        let endpoint = Url::parse(network.canonical_graphql_url()).map_err(|error| {
            CensusError::InvalidPayload(format!("canonical Sui GraphQL URL is invalid: {error}"))
        })?;
        let mut builder = reqwest::blocking::Client::builder()
            .timeout(Duration::from_millis(GRAPHQL_REQUEST_TIMEOUT_MS))
            .redirect(reqwest::redirect::Policy::none());
        if let Some(proxy_url) = non_empty(egress_proxy_url) {
            builder = builder.proxy(reqwest::Proxy::all(proxy_url).map_err(|error| {
                CensusError::InvalidPayload(format!(
                    "{CENSUS_GRAPHQL_EGRESS_PROXY_URL_KEY} is not a valid egress proxy URL: \
                     {error}"
                ))
            })?);
        }
        let http = builder.build().map_err(|error| {
            CensusError::InvalidPayload(format!("census GraphQL HTTP client is invalid: {error}"))
        })?;
        Ok(Self { endpoint, http })
    }
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

pub fn parse_latest_checkpoint_at_or_before(
    response: &Value,
    occurred_at_ms: u64,
) -> Result<u64, CensusError> {
    let nodes = read_array_path(
        response,
        &["data", "checkpoints", "nodes"],
        "checkpoint nodes",
    )?;
    let mut latest: Option<u64> = None;
    for node in nodes {
        let sequence_number =
            read_u64_path(node, &["sequenceNumber"], "checkpoint sequenceNumber")?;
        let timestamp_ms = read_u64_path(node, &["timestampMs"], "checkpoint timestampMs")?;
        if timestamp_ms <= occurred_at_ms
            && latest.is_none_or(|previous| previous < sequence_number)
        {
            latest = Some(sequence_number);
        }
    }
    latest.ok_or_else(|| {
        CensusError::InvalidPayload(
            "no Sui checkpoint exists at or before occurred_at_ms".to_owned(),
        )
    })
}

pub fn parse_cell_count_index_metadata(
    response: &Value,
    expected_package_id: &str,
    expected_membership_registry_id: &str,
) -> Result<CellCountIndexMetadata, CensusError> {
    validate_object_id(expected_package_id, "package_id")?;
    validate_object_id(expected_membership_registry_id, "membership_registry_id")?;
    let mut candidate: Option<CellCountIndexMetadata> = None;
    for event_json in graphql_event_json_nodes(response)? {
        let package_id = read_object_id_field(event_json, "package_id")?;
        let membership_registry_id = read_object_id_field(event_json, "membership_registry_id")?;
        if !same_object_id(&package_id, expected_package_id)
            || !same_object_id(&membership_registry_id, expected_membership_registry_id)
        {
            continue;
        }
        let metadata = CellCountIndexMetadata {
            cell_count_index_id: read_object_id_field(event_json, "cell_count_index_id")?,
            h3_resolution: read_u8_field(event_json, "h3_resolution")?,
            shard_count: read_u64_field(event_json, "shard_count")?,
        };
        if metadata.h3_resolution != crate::H3_RESOLUTION {
            return Err(CensusError::InvalidPayload(
                "CellCountIndex h3_resolution must be 7".to_owned(),
            ));
        }
        if metadata.shard_count != crate::SHARD_COUNT {
            return Err(CensusError::InvalidPayload(
                "CellCountIndex shard_count must be 4096".to_owned(),
            ));
        }
        if candidate.replace(metadata).is_some() {
            return Err(CensusError::InvalidPayload(
                "multiple matching CellCountIndexPublished events found".to_owned(),
            ));
        }
    }
    candidate.ok_or_else(|| {
        CensusError::InvalidPayload("CellCountIndexPublished event not found".to_owned())
    })
}

pub fn parse_cell_count_shard_object_ids(
    response: &Value,
    expected_package_id: &str,
    expected_cell_count_index_id: &str,
    required_shard_ids: &HashSet<u64>,
) -> Result<HashMap<u64, String>, CensusError> {
    validate_object_id(expected_package_id, "package_id")?;
    validate_object_id(expected_cell_count_index_id, "cell_count_index_id")?;
    let mut shards = HashMap::new();
    for event_json in graphql_event_json_nodes(response)? {
        let package_id = read_object_id_field(event_json, "package_id")?;
        let cell_count_index_id = read_object_id_field(event_json, "cell_count_index_id")?;
        if !same_object_id(&package_id, expected_package_id)
            || !same_object_id(&cell_count_index_id, expected_cell_count_index_id)
        {
            continue;
        }
        let shard_id = read_u64_field(event_json, "shard_id")?;
        if !required_shard_ids.contains(&shard_id) {
            continue;
        }
        let shard_object_id = read_object_id_field(event_json, "shard_object_id")?;
        if shards.insert(shard_id, shard_object_id).is_some() {
            return Err(CensusError::InvalidPayload(format!(
                "duplicate CellCountShardPublished event for shard_id {shard_id}"
            )));
        }
    }
    Ok(shards)
}

fn graphql_event_json_nodes(response: &Value) -> Result<Vec<&Value>, CensusError> {
    let nodes = read_array_path(
        response,
        &["data", "events", "nodes"],
        "GraphQL event nodes",
    )?;
    nodes
        .iter()
        .map(|node| {
            read_path(node, &["contents", "json"], "GraphQL event contents.json").and_then(|json| {
                json.as_object().map(|_| json).ok_or_else(|| {
                    CensusError::InvalidPayload(
                        "GraphQL event contents.json is malformed".to_owned(),
                    )
                })
            })
        })
        .collect()
}

fn read_path<'a>(value: &'a Value, path: &[&str], field: &str) -> Result<&'a Value, CensusError> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment).ok_or_else(|| {
            CensusError::InvalidPayload(format!("{field} is missing or malformed"))
        })?;
    }
    Ok(current)
}

fn read_array_path<'a>(
    value: &'a Value,
    path: &[&str],
    field: &str,
) -> Result<&'a Vec<Value>, CensusError> {
    read_path(value, path, field)?
        .as_array()
        .ok_or_else(|| CensusError::InvalidPayload(format!("{field} is missing or malformed")))
}

fn read_u64_path(value: &Value, path: &[&str], field: &str) -> Result<u64, CensusError> {
    read_u64_value(read_path(value, path, field)?, field)
}

fn read_u64_field(value: &Value, field: &str) -> Result<u64, CensusError> {
    read_u64_value(
        value
            .get(field)
            .ok_or_else(|| CensusError::InvalidPayload(format!("{field} is missing")))?,
        field,
    )
}

fn read_u8_field(value: &Value, field: &str) -> Result<u8, CensusError> {
    let raw = read_u64_field(value, field)?;
    u8::try_from(raw).map_err(|_| CensusError::InvalidPayload(format!("{field} must be a u8")))
}

fn read_u64_value(value: &Value, field: &str) -> Result<u64, CensusError> {
    match value {
        Value::Number(number) => number
            .as_u64()
            .ok_or_else(|| CensusError::InvalidPayload(format!("{field} must be a u64"))),
        Value::String(raw) => parse_canonical_u64(raw, field),
        _ => Err(CensusError::InvalidPayload(format!(
            "{field} must be a u64"
        ))),
    }
}

fn parse_canonical_u64(value: &str, field: &str) -> Result<u64, CensusError> {
    if value.is_empty() || (value != "0" && value.starts_with('0')) {
        return Err(CensusError::InvalidPayload(format!(
            "{field} must be canonical decimal u64"
        )));
    }
    if !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(CensusError::InvalidPayload(format!(
            "{field} must be canonical decimal u64"
        )));
    }
    value
        .parse::<u64>()
        .map_err(|_| CensusError::InvalidPayload(format!("{field} must be canonical decimal u64")))
}

fn read_object_id_field(value: &Value, field: &str) -> Result<String, CensusError> {
    let raw = value
        .get(field)
        .ok_or_else(|| CensusError::InvalidPayload(format!("{field} is missing")))?;
    let object_id = match raw {
        Value::String(value) => value.as_str(),
        Value::Object(object) => object
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| CensusError::InvalidPayload(format!("{field} is malformed")))?,
        _ => {
            return Err(CensusError::InvalidPayload(format!("{field} is malformed")));
        }
    };
    validate_object_id(object_id, field)?;
    Ok(normalize_object_id(object_id))
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

fn normalize_object_id(value: &str) -> String {
    format!("0x{}", value.trim_start_matches("0x").to_ascii_lowercase())
}

fn same_object_id(left: &str, right: &str) -> bool {
    normalize_object_id(left) == normalize_object_id(right)
}

#[cfg(test)]
mod tests {
    use super::{
        CENSUS_GRAPHQL_EGRESS_PROXY_URL_KEY, CENSUS_GRAPHQL_NETWORK_KEY, CensusGraphqlClient,
        SuiGraphqlNetwork, parse_cell_count_index_metadata, parse_cell_count_shard_object_ids,
        parse_latest_checkpoint_at_or_before,
    };
    use sonari_tee_core::TeeContext;
    use std::collections::HashSet;

    #[test]
    fn network_resolves_to_canonical_sui_graphql_url() {
        assert_eq!(
            SuiGraphqlNetwork::parse("mainnet")
                .unwrap()
                .canonical_graphql_url(),
            "https://graphql.mainnet.sui.io/graphql",
        );
        assert_eq!(
            SuiGraphqlNetwork::parse("testnet")
                .unwrap()
                .canonical_graphql_url(),
            "https://graphql.testnet.sui.io/graphql",
        );
    }

    #[test]
    fn client_uses_context_network_and_rejects_unknown_network() {
        let ctx = TeeContext::with_env([(CENSUS_GRAPHQL_NETWORK_KEY, "testnet")]);
        let client = CensusGraphqlClient::from_context(&ctx).unwrap();

        assert_eq!(
            client.endpoint.as_str(),
            "https://graphql.testnet.sui.io/graphql",
        );

        let ctx = TeeContext::with_env([(CENSUS_GRAPHQL_NETWORK_KEY, "unknown")]);
        let error = CensusGraphqlClient::from_context(&ctx).unwrap_err();
        assert!(error.to_string().contains("unsupported"));
    }

    #[test]
    fn client_requires_network_and_accepts_proxy_only_as_routing_input() {
        let error = CensusGraphqlClient::from_context(&TeeContext::new()).unwrap_err();
        assert!(error.to_string().contains(CENSUS_GRAPHQL_NETWORK_KEY));

        let ctx = TeeContext::with_env([
            (CENSUS_GRAPHQL_NETWORK_KEY, "mainnet"),
            (
                CENSUS_GRAPHQL_EGRESS_PROXY_URL_KEY,
                "http://127.0.0.1:18080",
            ),
        ]);
        let client = CensusGraphqlClient::from_context(&ctx).unwrap();

        assert_eq!(
            client.endpoint.as_str(),
            "https://graphql.mainnet.sui.io/graphql",
        );
    }

    #[test]
    fn client_rejects_malformed_proxy() {
        let ctx = TeeContext::with_env([
            (CENSUS_GRAPHQL_NETWORK_KEY, "testnet"),
            (CENSUS_GRAPHQL_EGRESS_PROXY_URL_KEY, "not a url"),
        ]);

        let error = CensusGraphqlClient::from_context(&ctx).unwrap_err();

        assert!(error.to_string().contains("egress proxy"));
    }

    #[test]
    fn checkpoint_parser_selects_latest_checkpoint_at_or_before_event_time() {
        let response = serde_json::json!({
            "data": {
                "checkpoints": {
                    "nodes": [
                        { "sequenceNumber": "40", "timestampMs": "900" },
                        { "sequenceNumber": "41", "timestampMs": "1000" },
                        { "sequenceNumber": "42", "timestampMs": "1001" }
                    ]
                }
            }
        });

        assert_eq!(
            parse_latest_checkpoint_at_or_before(&response, 1_000).unwrap(),
            41,
        );
    }

    #[test]
    fn checkpoint_parser_rejects_when_no_checkpoint_is_old_enough() {
        let response = serde_json::json!({
            "data": { "checkpoints": { "nodes": [{ "sequenceNumber": 1, "timestampMs": 10 }] } }
        });

        let error = parse_latest_checkpoint_at_or_before(&response, 9).unwrap_err();

        assert!(error.to_string().contains("checkpoint"));
    }

    #[test]
    fn index_parser_finds_matching_cell_count_index_metadata() {
        let package_id = object_id("aa");
        let membership_registry_id = object_id("22");
        let index_id = object_id("33");
        let response = serde_json::json!({
            "data": {
                "events": {
                    "nodes": [
                        { "contents": { "json": {
                            "package_id": object_id("ff"),
                            "membership_registry_id": membership_registry_id,
                            "cell_count_index_id": object_id("44"),
                            "h3_resolution": 7,
                            "shard_count": "4096"
                        }}},
                        { "contents": { "json": {
                            "package_id": package_id,
                            "membership_registry_id": membership_registry_id,
                            "cell_count_index_id": index_id,
                            "h3_resolution": 7,
                            "shard_count": "4096"
                        }}}
                    ]
                }
            }
        });

        let metadata =
            parse_cell_count_index_metadata(&response, &package_id, &membership_registry_id)
                .unwrap();

        assert_eq!(metadata.cell_count_index_id, index_id);
        assert_eq!(metadata.h3_resolution, 7);
        assert_eq!(metadata.shard_count, 4_096);
    }

    #[test]
    fn index_parser_rejects_wrong_metadata_and_ambiguous_matches() {
        let package_id = object_id("aa");
        let membership_registry_id = object_id("22");
        let response = serde_json::json!({
            "data": {
                "events": {
                    "nodes": [
                        { "contents": { "json": {
                            "package_id": package_id,
                            "membership_registry_id": membership_registry_id,
                            "cell_count_index_id": object_id("33"),
                            "h3_resolution": 8,
                            "shard_count": "4096"
                        }}}
                    ]
                }
            }
        });
        assert!(
            parse_cell_count_index_metadata(&response, &package_id, &membership_registry_id)
                .unwrap_err()
                .to_string()
                .contains("h3_resolution")
        );

        let response = serde_json::json!({
            "data": {
                "events": {
                    "nodes": [
                        { "contents": { "json": {
                            "package_id": package_id,
                            "membership_registry_id": membership_registry_id,
                            "cell_count_index_id": object_id("33"),
                            "h3_resolution": 7,
                            "shard_count": "4096"
                        }}},
                        { "contents": { "json": {
                            "package_id": package_id,
                            "membership_registry_id": membership_registry_id,
                            "cell_count_index_id": object_id("44"),
                            "h3_resolution": 7,
                            "shard_count": "4096"
                        }}}
                    ]
                }
            }
        });
        assert!(
            parse_cell_count_index_metadata(&response, &package_id, &membership_registry_id)
                .unwrap_err()
                .to_string()
                .contains("multiple")
        );
    }

    #[test]
    fn shard_parser_returns_only_required_shards_for_matching_index() {
        let package_id = object_id("aa");
        let index_id = object_id("33");
        let shard_10 = object_id("10");
        let shard_20 = object_id("20");
        let response = serde_json::json!({
            "data": {
                "events": {
                    "nodes": [
                        { "contents": { "json": {
                            "package_id": package_id,
                            "cell_count_index_id": index_id,
                            "shard_id": "10",
                            "shard_object_id": shard_10
                        }}},
                        { "contents": { "json": {
                            "package_id": package_id,
                            "cell_count_index_id": index_id,
                            "shard_id": "20",
                            "shard_object_id": shard_20
                        }}},
                        { "contents": { "json": {
                            "package_id": package_id,
                            "cell_count_index_id": index_id,
                            "shard_id": "30",
                            "shard_object_id": object_id("30")
                        }}}
                    ]
                }
            }
        });
        let required = HashSet::from([10, 20]);

        let shards =
            parse_cell_count_shard_object_ids(&response, &package_id, &index_id, &required)
                .unwrap();

        assert_eq!(shards.len(), 2);
        assert_eq!(shards.get(&10), Some(&shard_10));
        assert_eq!(shards.get(&20), Some(&shard_20));
    }

    #[test]
    fn shard_parser_rejects_duplicate_required_shard() {
        let package_id = object_id("aa");
        let index_id = object_id("33");
        let response = serde_json::json!({
            "data": {
                "events": {
                    "nodes": [
                        { "contents": { "json": {
                            "package_id": package_id,
                            "cell_count_index_id": index_id,
                            "shard_id": "10",
                            "shard_object_id": object_id("10")
                        }}},
                        { "contents": { "json": {
                            "package_id": package_id,
                            "cell_count_index_id": index_id,
                            "shard_id": "10",
                            "shard_object_id": object_id("11")
                        }}}
                    ]
                }
            }
        });

        let error = parse_cell_count_shard_object_ids(
            &response,
            &package_id,
            &index_id,
            &HashSet::from([10]),
        )
        .unwrap_err();

        assert!(error.to_string().contains("duplicate"));
    }

    fn object_id(byte: &str) -> String {
        format!("0x{}", byte.repeat(32))
    }
}
