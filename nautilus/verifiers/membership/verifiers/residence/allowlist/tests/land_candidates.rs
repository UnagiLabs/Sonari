use h3o::{
    LatLng, Resolution,
    geom::{ContainmentMode, TilerBuilder},
};
use residence_allowlist::{
    NATURAL_EARTH_LAND_SOURCE, generate_candidate_h3_indexes_from_geojson,
    load_land_polygons_from_geojson,
};
use std::collections::BTreeSet;

const COMPACT_LAND: &str = include_str!("../fixtures/compact_land.geojson");

fn coverage_with_mode(mode: ContainmentMode) -> BTreeSet<u64> {
    let polygons = load_land_polygons_from_geojson(COMPACT_LAND).expect("fixture parses");
    let mut tiler = TilerBuilder::new(Resolution::Seven)
        .containment_mode(mode)
        .build();
    tiler
        .add_batch(polygons)
        .expect("fixture geometry is valid");

    tiler.into_coverage().map(u64::from).collect()
}

#[test]
fn source_manifest_pins_natural_earth_land_metadata() {
    assert_eq!(
        NATURAL_EARTH_LAND_SOURCE.source_name,
        "Natural Earth ne_10m_land"
    );
    assert_eq!(NATURAL_EARTH_LAND_SOURCE.version, "v5.1.2");
    assert_eq!(
        NATURAL_EARTH_LAND_SOURCE.url,
        "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_land.geojson"
    );
    assert_eq!(
        NATURAL_EARTH_LAND_SOURCE.sha256,
        "1ac90796408bc6ad6911d69448485d3c4dbf2190370080368a09976e1c9f7416"
    );
    assert_eq!(NATURAL_EARTH_LAND_SOURCE.resolution, 7);
    assert_eq!(
        NATURAL_EARTH_LAND_SOURCE.containment_mode,
        "h3o::geom::ContainmentMode::Covers"
    );
}

#[test]
fn land_interior_cell_is_included_and_far_ocean_cell_is_excluded() {
    let candidates = generate_candidate_h3_indexes_from_geojson(COMPACT_LAND).expect("candidates");
    let candidate_set = candidates.into_iter().collect::<BTreeSet<_>>();

    let interior = LatLng::new(40.7600, -73.9700)
        .expect("valid coordinate")
        .to_cell(Resolution::Seven);
    let far_ocean = LatLng::new(0.0, -140.0)
        .expect("valid coordinate")
        .to_cell(Resolution::Seven);

    assert!(candidate_set.contains(&u64::from(interior)));
    assert!(!candidate_set.contains(&u64::from(far_ocean)));
}

#[test]
fn boundary_overlap_cells_come_from_covers_not_centroid_mode() {
    let covers = generate_candidate_h3_indexes_from_geojson(COMPACT_LAND)
        .expect("covers candidates")
        .into_iter()
        .collect::<BTreeSet<_>>();
    let centroid = coverage_with_mode(ContainmentMode::ContainsCentroid);

    let boundary_overlap = covers
        .difference(&centroid)
        .next()
        .expect("fixture must exercise Covers beyond centroid containment");
    assert!(covers.contains(boundary_overlap));
}

#[test]
fn malformed_geojson_source_fails_closed() {
    assert!(load_land_polygons_from_geojson("{").is_err());
    assert!(
        load_land_polygons_from_geojson(
            r#"{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[0,0]}}]}"#
        )
        .is_err()
    );
}

#[test]
fn generated_h3_indexes_are_sorted_unique() {
    let candidates = generate_candidate_h3_indexes_from_geojson(COMPACT_LAND).expect("candidates");
    assert!(!candidates.is_empty());

    let mut sorted = candidates.clone();
    sorted.sort_unstable();
    sorted.dedup();

    assert_eq!(candidates, sorted);
}
