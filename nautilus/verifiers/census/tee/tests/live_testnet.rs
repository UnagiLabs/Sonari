//! Live testnet verification for the Census TEE GraphQL reader (issue #448).
//!
//! These tests are `#[ignore]` because they hit the live Sui testnet GraphQL
//! endpoint and depend on the currently published Sonari package and on-chain
//! membership state. Run them explicitly:
//!
//! ```bash
//! cargo test -p census-tee --test live_testnet -- --ignored --nocapture
//! ```
//!
//! They answer the core question of issue #448: does the Census TEE actually
//! fetch Sui state from inside the verifier via GraphQL `atCheckpoint`, and does
//! it correctly arrive at the registered-member counts (including a legitimate
//! zero for cells with no members)?
//!
//! The deployed object ids default to the testnet deployment resolved from
//! `contracts/Published.toml`; override them via env vars when the deployment
//! changes:
//!   SONARI_PACKAGE_ID, SONARI_MEMBERSHIP_REGISTRY_ID, SONARI_MEMBER_CELL.

use std::time::{SystemTime, UNIX_EPOCH};

use census_tee::graphql::{CensusGraphqlClient, SuiGraphqlNetwork};
use census_tee::{AffectedCell, AffectedCellsArtifact, CensusInputBundle};

// Current testnet deployment (contracts/Published.toml, resolved 2026-06-18).
const DEFAULT_PACKAGE_ID: &str =
    "0x03a2031d69d0f5eb2ce33753860aed3fd6256659b904394c9eae1a48350b12c0";
const DEFAULT_MEMBERSHIP_REGISTRY_ID: &str =
    "0xd11600ccd2a106bf33479e431fb20fa6fb9e1ee025c8cddbc70598bb2e1d4b20";
// The single member currently registered on-chain (Tokyo, active_count = 1).
const DEFAULT_MEMBER_CELL: &str = "608818980815110143";
// Noto Peninsula 2024 fixture (us6000m0xl).
const NOTO_EVENT_UID: &str = "0x761f8694f710f24141f4aed210b64a2ac5172d3362dec1e5d62295f44bfd437d";
const NOTO_OCCURRED_AT_MS: u64 = 1_704_093_009_476; // 2024-01-01T07:10:09Z

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_owned())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before epoch")
        .as_millis() as u64
}

fn client() -> CensusGraphqlClient {
    // Outside the enclave there is no egress proxy; hit canonical testnet GraphQL.
    CensusGraphqlClient::from_network_and_proxy(SuiGraphqlNetwork::Testnet, None)
        .expect("build testnet GraphQL client")
}

fn affected_cells(cells: Vec<(&str, u64)>) -> AffectedCellsArtifact {
    AffectedCellsArtifact {
        event_uid: NOTO_EVENT_UID.to_owned(),
        event_revision: 1,
        oracle_version: 1,
        geo_resolution: 7,
        cells_generation_method: "shakemap_gridxml_h3_center_bilinear_v1".to_owned(),
        cell_metric: "USGS_MMI".to_owned(),
        cell_aggregation: "H3_CENTER_BILINEAR".to_owned(),
        intensity_scale: "MMI_X100".to_owned(),
        affected_cells: cells
            .into_iter()
            .map(|(h3, band)| AffectedCell {
                h3_index: h3.to_owned(),
                intensity_value: 800,
                cell_band: band,
            })
            .collect(),
    }
}

fn bundle(occurred_at_ms: u64, cells: Vec<(&str, u64)>) -> CensusInputBundle {
    CensusInputBundle {
        package_id: env_or("SONARI_PACKAGE_ID", DEFAULT_PACKAGE_ID),
        event_uid: NOTO_EVENT_UID.to_owned(),
        event_revision: 1,
        occurred_at_ms,
        affected_cells_root: "0x".to_owned() + &"00".repeat(32),
        issued_at_ms: now_ms(),
        campaign_id: "0x".to_owned() + &"00".repeat(32),
        disaster_event_id: "0x".to_owned() + &"00".repeat(32),
        membership_registry_id: env_or(
            "SONARI_MEMBERSHIP_REGISTRY_ID",
            DEFAULT_MEMBERSHIP_REGISTRY_ID,
        ),
        affected_cells: affected_cells(cells),
    }
}

/// Proves the TEE GraphQL reader fetches the *real* on-chain count: the single
/// registered member's cell must read `active_count = 1` at a recent checkpoint.
#[test]
#[ignore = "hits live Sui testnet GraphQL"]
fn live_reads_real_member_count_at_recent_checkpoint() {
    let member_cell = env_or("SONARI_MEMBER_CELL", DEFAULT_MEMBER_CELL);
    let snapshot = client()
        .resolve_counted_cells(&bundle(now_ms(), vec![(member_cell.as_str(), 1)]))
        .expect("census GraphQL read should succeed at a recent checkpoint");

    eprintln!("census_checkpoint = {}", snapshot.census_checkpoint);
    for cell in &snapshot.counted_cells {
        eprintln!(
            "  cell {} shard {} band {} active_count {}",
            cell.h3_cell, cell.shard_id, cell.cell_band, cell.active_count
        );
    }
    let member = snapshot
        .counted_cells
        .iter()
        .find(|c| c.h3_cell == member_cell)
        .expect("member cell must be present in counted cells");
    assert_eq!(
        member.active_count, "1",
        "registered member cell must read active_count = 1 from GraphQL atCheckpoint"
    );
    assert!(snapshot.census_checkpoint > 0);
}

/// Proves the TEE GraphQL reader correctly judges zero for affected cells that
/// have no registered members (the Noto affected area), reading at a recent
/// checkpoint so the read mechanism itself is exercised end to end.
#[test]
#[ignore = "hits live Sui testnet GraphQL"]
fn live_judges_zero_for_noto_cells_without_members() {
    // A representative subset of the Noto Peninsula 2024 affected cells (bands 1/2/3).
    let noto_cells = vec![
        ("608799883394023423", 1),
        ("608799887152119807", 2),
        ("608800039824785407", 3),
    ];
    let snapshot = client()
        .resolve_counted_cells(&bundle(now_ms(), noto_cells))
        .expect("census GraphQL read should succeed at a recent checkpoint");

    eprintln!("census_checkpoint = {}", snapshot.census_checkpoint);
    for cell in &snapshot.counted_cells {
        eprintln!(
            "  cell {} shard {} band {} active_count {}",
            cell.h3_cell, cell.shard_id, cell.cell_band, cell.active_count
        );
    }
    for cell in &snapshot.counted_cells {
        assert_eq!(
            cell.active_count, "0",
            "Noto affected cell {} must read zero (no registered members)",
            cell.h3_cell
        );
    }
}

/// Proves binary-search checkpoint resolution reaches a multi-hour-old occurrence
/// time. Linear backward pagination could only reach ~25k checkpoints (~2-3h) behind
/// the tip; binary search resolves any retained checkpoint in O(log N) point lookups.
#[test]
#[ignore = "hits live Sui testnet GraphQL"]
fn live_binary_search_resolves_multi_hour_old_occurrence() {
    let occurred_at_ms = now_ms() - 4 * 3_600_000; // ~4 hours behind the chain tip
    let member_cell = env_or("SONARI_MEMBER_CELL", DEFAULT_MEMBER_CELL);
    let snapshot = client()
        .resolve_counted_cells(&bundle(occurred_at_ms, vec![(member_cell.as_str(), 1)]))
        .expect("binary search should resolve a multi-hour-old occurrence time");

    eprintln!(
        "occurred {}ms ago resolved census_checkpoint = {}",
        4 * 3_600_000,
        snapshot.census_checkpoint
    );
    assert!(snapshot.census_checkpoint > 0);
}

/// Observes the behavior for the *literal* historical Noto timestamp
/// (2024-01-01). The Census TEE resolves `census_checkpoint` as the latest
/// checkpoint at or before `occurred_at_ms`; for a 2.5-year-old event this
/// exercises checkpoint pagination far into the past. This test only reports
/// the outcome (it never asserts) so the temporal limitation is visible.
#[test]
#[ignore = "hits live Sui testnet GraphQL"]
fn live_reports_historical_noto_timestamp_behavior() {
    let member_cell = env_or("SONARI_MEMBER_CELL", DEFAULT_MEMBER_CELL);
    match client().resolve_counted_cells(&bundle(
        NOTO_OCCURRED_AT_MS,
        vec![(member_cell.as_str(), 1)],
    )) {
        Ok(snapshot) => {
            eprintln!(
                "historical occurred_at_ms resolved census_checkpoint = {}",
                snapshot.census_checkpoint
            );
            for cell in &snapshot.counted_cells {
                eprintln!("  cell {} active_count {}", cell.h3_cell, cell.active_count);
            }
        }
        Err(error) => {
            eprintln!("historical occurred_at_ms failed (expected for an old event): {error}");
        }
    }
}
