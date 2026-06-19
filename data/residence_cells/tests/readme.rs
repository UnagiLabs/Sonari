const README: &str = include_str!("../README.md");
const OPERATIONS_RUNBOOK: &str =
    include_str!("../../../docs/internal/operations/residence_cells_pipeline.md");

#[test]
fn readme_documents_r2_proof_shard_operations() {
    assert_required_terms([
        "proof-shards",
        "verify-proof-shards",
        "proof_manifest.json",
        "total_proof_count",
        "inventory",
        "empty shards",
        ".json.gz",
        "residence-cells/v{allowlist_version}/res{geo_resolution}/proofs/shards/{shard_id:05}.json.gz",
    ]);

    assert_required_terms([
        "SONARI_R2_BUCKET",
        "CLOUDFLARE_ACCOUNT_ID",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "--endpoint-url \"https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com\"",
        "aws s3 sync",
        "verify-proof-shards",
    ]);

    assert_required_terms([
        "aws s3 rm",
        "--recursive",
        "--dryrun",
        "R2 verification",
        "old S3 proof/tree artifacts",
    ]);

    assert_required_terms([
        "R2 Standard storage",
        "Worker serving path reads R2",
        "no per-proof DynamoDB/KV writes",
        "Worker does not read S3 on serving path",
        "R2 Infrequent Access",
        "not for MVP serving path",
        "R2/Worker are distribution surfaces",
        "Move contract verifies proof/root",
    ]);

    assert_required_terms([
        "GET /api/residence-proof?h3_index=608819013681676287",
        "RESIDENCE_PROOF_SHARDS",
        "ALLOWLIST_VERSION",
        "GEO_RESOLUTION",
        "residence-cells/v{allowlist_version}/res{geo_resolution}/proofs/proof_manifest.json",
        "manifest cache",
        "sha256",
        "byte_size",
        "per-proof KV writes",
        "per-proof DynamoDB writes",
    ]);
}

#[test]
fn readme_documents_tile_operations() {
    assert_required_terms([
        "sonari.residence.tile.v1",
        "sonari.residence.tile_manifest.v1",
        "tile_manifest.json",
        "tile_parent_resolution",
        "parent_h3_index",
        "total_cell_count",
        "residence-cells/v{allowlist_version}/res{geo_resolution}/tiles/res4/{parent_hex}.json",
    ]);

    assert_required_terms([
        "tiles",
        "verify-tiles",
        "--tiles-dir",
        "--tile-manifest",
        "--proof-manifest",
    ]);

    assert_required_terms([
        "Cache-Control: public, max-age=31536000, immutable",
        "404",
        "all water",
        "map display",
    ]);
}

#[test]
fn readme_documents_operations_tile_publication_safety() {
    assert_required_operations_terms([
        "sonari-residence-proofs-v1-res7",
        "aws s3 sync --dryrun --delete",
        "aws s3 cp",
        "R2 exact bytes",
        "prefix parity",
        "余剰 `res4/*.json`",
        "SONARI_RESIDENCE_TILE_MANIFEST_SHA256",
        "lowercase 64 hex",
    ]);

    assert_required_operations_terms([
        "aws-sonari-verifier-runner-dev",
        "environment Variables",
        "repo-level Variables",
        "SONARI_RESIDENCE_ROOT",
        "SONARI_GEO_RESOLUTION",
        "gh variable list --env aws-sonari-verifier-runner-dev",
    ]);
}

fn assert_required_terms<const N: usize>(terms: [&str; N]) {
    for term in terms {
        assert!(README.contains(term), "README must contain {term:?}");
    }
}

fn assert_required_operations_terms<const N: usize>(terms: [&str; N]) {
    for term in terms {
        assert!(
            OPERATIONS_RUNBOOK.contains(term),
            "operations runbook must contain {term:?}",
        );
    }
}
