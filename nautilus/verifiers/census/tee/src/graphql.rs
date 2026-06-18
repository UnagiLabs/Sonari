use crate::CensusError;
use reqwest::Url;
use sonari_tee_core::TeeContext;
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

#[cfg(test)]
mod tests {
    use super::{
        CENSUS_GRAPHQL_EGRESS_PROXY_URL_KEY, CENSUS_GRAPHQL_NETWORK_KEY, CensusGraphqlClient,
        SuiGraphqlNetwork,
    };
    use sonari_tee_core::TeeContext;

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
}
