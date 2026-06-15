/**
 * proof_artifacts.ts
 *
 * R2 保存形（manifest / shard entry）の型定義・parse 関数と、
 * entry 検索・配信レスポンス整形の自前実装。
 *
 * proof-core から findProofEntry / shapeProofResponse は export されていないため、
 * ここに自前実装する。proof-core からは生成/検証/hash/schema util のみ import する。
 *
 * bigint の JSON 表現:
 * - h3_index (u64 bigint)  → 10 進 decimal string で保存・復元
 * - oracle_version (u64 bigint) → 10 進 decimal string で保存・復元
 *
 * これにより JSON.stringify/parse の制約（bigint 非対応）を回避する。
 */

import type { AffectedCellLeaf, PrefixedHex32, ProofStep } from "@sonari/proof-core";
import {
    expectArray,
    expectBoolean,
    expectKeys,
    expectNonNegativeSafeInteger,
    expectPositiveSafeInteger,
    expectPrefixedHex32,
    expectRecord,
    expectString,
    type JsonRecord,
} from "@sonari/proof-core";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * R2 に保存する manifest の型。
 * 配信時に Walrus から再取得するための metadata（affected_cells_uri / hash / root / count / geo_resolution）を含む。
 */
export interface AffectedCellsProofManifest {
    schema_version: number;
    event_uid: PrefixedHex32;
    event_revision: number;
    /** 元の Walrus URI（R2 miss 時の再生成に使用） */
    affected_cells_uri: string;
    /** 登録時に検証済みの SHA-256 hash（0x-prefixed hex32） */
    affected_cells_hash: PrefixedHex32;
    /** merkle root（0x-prefixed hex32） */
    affected_cells_root: PrefixedHex32;
    affected_cell_count: number;
    geo_resolution: number;
    shards: AffectedCellsManifestShardEntry[];
}

export interface AffectedCellsManifestShardEntry {
    shard_key: string;
    r2_key: string;
    hash: PrefixedHex32;
    cell_count: number;
}

/** `unknown` → `AffectedCellsProofManifest`（壊れ JSON を弾く） */
export function parseProofManifest(value: unknown): AffectedCellsProofManifest {
    const record = expectRecord("proof manifest", value);
    expectKeys("proof manifest", record, [
        "schema_version",
        "event_uid",
        "event_revision",
        "affected_cells_uri",
        "affected_cells_hash",
        "affected_cells_root",
        "affected_cell_count",
        "geo_resolution",
        "shards",
    ]);

    const schema_version = expectPositiveSafeInteger("schema_version", record.schema_version);
    const event_uid = expectPrefixedHex32("event_uid", record.event_uid);
    const event_revision = expectPositiveSafeInteger("event_revision", record.event_revision);
    const affected_cells_uri = expectString("affected_cells_uri", record.affected_cells_uri);
    const affected_cells_hash = expectPrefixedHex32(
        "affected_cells_hash",
        record.affected_cells_hash,
    );
    const affected_cells_root = expectPrefixedHex32(
        "affected_cells_root",
        record.affected_cells_root,
    );
    const affected_cell_count = expectNonNegativeSafeInteger(
        "affected_cell_count",
        record.affected_cell_count,
    );
    const geo_resolution = expectNonNegativeSafeInteger("geo_resolution", record.geo_resolution);
    const rawShards = expectArray("shards", record.shards);
    const shards = rawShards.map((s) => parseManifestShardEntry(s));

    return {
        schema_version,
        event_uid,
        event_revision,
        affected_cells_uri,
        affected_cells_hash,
        affected_cells_root,
        affected_cell_count,
        geo_resolution,
        shards,
    };
}

function parseManifestShardEntry(value: unknown): AffectedCellsManifestShardEntry {
    const record = expectRecord("manifest shard entry", value);
    expectKeys("manifest shard entry", record, ["shard_key", "r2_key", "hash", "cell_count"]);

    return {
        shard_key: expectString("shard_key", record.shard_key),
        r2_key: expectString("r2_key", record.r2_key),
        hash: expectPrefixedHex32("hash", record.hash),
        cell_count: expectNonNegativeSafeInteger("cell_count", record.cell_count),
    };
}

// ---------------------------------------------------------------------------
// Shard Entry
// ---------------------------------------------------------------------------

/**
 * R2 に保存する shard entry の型。
 *
 * AffectedCellLeaf の全フィールドに加え、leaf_hash と proof を含む。
 * 配信時に affectedCellLeafHash で leaf_hash を独立再計算できるよう
 * leaf の全フィールドを保存する（B3 要件）。
 *
 * bigint フィールド:
 * - h3_index: JSON では decimal string で保存し、parse 時に bigint に復元
 * - oracle_version: JSON では decimal string で保存し、parse 時に bigint に復元
 */
export interface AffectedCellsProofShardEntry extends AffectedCellLeaf {
    leaf_hash: PrefixedHex32;
    proof: ProofStep[];
}

/** `unknown` → `AffectedCellsProofShardEntry`（壊れ JSON を弾く） */
export function parseShardEntry(value: unknown): AffectedCellsProofShardEntry {
    const record = expectRecord("shard entry", value) as JsonRecord;
    expectKeys("shard entry", record, [
        "event_uid",
        "event_revision",
        "geo_resolution",
        "h3_index",
        "cell_band",
        "intensity_value",
        "cell_metric",
        "intensity_scale",
        "cells_generation_method",
        "oracle_version",
        "leaf_hash",
        "proof",
    ]);

    const event_uid = expectPrefixedHex32("event_uid", record.event_uid);
    const event_revision = expectPositiveSafeInteger("event_revision", record.event_revision);
    const geo_resolution = expectNonNegativeSafeInteger("geo_resolution", record.geo_resolution);

    // h3_index: JSON では decimal string で保存。parse して bigint に復元
    const h3_index = parseBigIntString("h3_index", record.h3_index);

    const cell_band = expectNonNegativeSafeInteger("cell_band", record.cell_band);
    const intensity_value = expectNonNegativeSafeInteger(
        "intensity_value",
        record.intensity_value,
    );

    const cell_metric = expectString("cell_metric", record.cell_metric);
    validateEnumValue("cell_metric", cell_metric, KNOWN_CELL_METRICS);

    const intensity_scale = expectString("intensity_scale", record.intensity_scale);
    validateEnumValue("intensity_scale", intensity_scale, KNOWN_INTENSITY_SCALES);

    const cells_generation_method = expectString(
        "cells_generation_method",
        record.cells_generation_method,
    );
    validateEnumValue(
        "cells_generation_method",
        cells_generation_method,
        KNOWN_CELLS_GENERATION_METHODS,
    );

    // oracle_version: JSON では decimal string で保存。parse して bigint に復元
    const oracle_version = parseBigIntString("oracle_version", record.oracle_version);

    const leaf_hash = expectPrefixedHex32("leaf_hash", record.leaf_hash);
    const rawProof = expectArray("proof", record.proof);
    const proof = rawProof.map(parseProofStep);

    return {
        event_uid,
        event_revision,
        geo_resolution,
        h3_index,
        cell_band,
        intensity_value,
        cell_metric: cell_metric as AffectedCellLeaf["cell_metric"],
        intensity_scale: intensity_scale as AffectedCellLeaf["intensity_scale"],
        cells_generation_method: cells_generation_method as AffectedCellLeaf["cells_generation_method"],
        oracle_version,
        leaf_hash,
        proof,
    };
}

// ---------------------------------------------------------------------------
// Entry 検索（自前実装: proof-core に findProofEntry は無い）
// ---------------------------------------------------------------------------

/**
 * shard 内の entry から指定 h3_index の entry を探す。
 * 見つからない場合は null を返す。
 *
 * Note: proof-core の findProofEntry は residence-proof-worker ローカルの実装であり、
 *       affected-cells 用には自前実装が必要。
 */
export function findShardEntry(
    entries: AffectedCellsProofShardEntry[],
    h3Index: bigint,
): AffectedCellsProofShardEntry | null {
    return entries.find((e) => e.h3_index === h3Index) ?? null;
}

// ---------------------------------------------------------------------------
// 配信レスポンス整形（自前実装: proof-core に shapeProofResponse は無い）
// ---------------------------------------------------------------------------

/**
 * 配信レスポンスの型。
 * leaf には AffectedCellLeaf 全フィールドを含む（配信前の leaf_hash 独立再計算に使用）。
 */
export interface AffectedCellsProofResponse {
    event_uid: PrefixedHex32;
    event_revision: number;
    /** decimal string（JSON 互換） */
    h3_index: string;
    affected_cells_root: PrefixedHex32;
    leaf: AffectedCellLeaf;
    proof: ProofStep[];
}

/**
 * entry と manifest から配信レスポンスを組み立てる。
 *
 * Note: proof-core の shapeProofResponse は residence-proof-worker ローカルの実装であり、
 *       affected-cells 用には自前実装が必要。
 */
export function shapeProofResponse(
    entry: AffectedCellsProofShardEntry,
    manifest: AffectedCellsProofManifest,
): AffectedCellsProofResponse {
    const leaf: AffectedCellLeaf = {
        event_uid: entry.event_uid,
        event_revision: entry.event_revision,
        h3_index: entry.h3_index,
        geo_resolution: entry.geo_resolution,
        cell_band: entry.cell_band,
        intensity_value: entry.intensity_value,
        cell_metric: entry.cell_metric,
        intensity_scale: entry.intensity_scale,
        cells_generation_method: entry.cells_generation_method,
        oracle_version: entry.oracle_version,
    };

    return {
        event_uid: manifest.event_uid,
        event_revision: manifest.event_revision,
        h3_index: entry.h3_index.toString(),
        affected_cells_root: manifest.affected_cells_root,
        leaf,
        proof: entry.proof,
    };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** JSON 保存された decimal string を bigint に復元する */
function parseBigIntString(name: string, value: unknown): bigint {
    const str = expectString(name, value);
    // 有効な decimal integer string のみ受理（先頭ゼロ禁止、負数禁止）
    if (!/^\d+$/.test(str) || (str.length > 1 && str.startsWith("0"))) {
        throw new Error(`${name} must be a valid non-negative decimal integer string, got "${str}"`);
    }
    return BigInt(str);
}

/** 既知の enum 値セットに含まれることを確認する */
function validateEnumValue(name: string, value: string, known: ReadonlySet<string>): void {
    if (!known.has(value)) {
        throw new Error(`${name} has unknown value: "${value}"`);
    }
}

function parseProofStep(value: unknown): ProofStep {
    const record = expectRecord("proof step", value);
    expectKeys("proof step", record, ["sibling_on_left", "sibling_hash"]);
    return {
        sibling_on_left: expectBoolean("sibling_on_left", record.sibling_on_left),
        sibling_hash: expectPrefixedHex32("sibling_hash", record.sibling_hash),
    };
}

// Known enum value sets (must match proof-core's affected-cell-leaf.ts)
const KNOWN_CELL_METRICS: ReadonlySet<string> = new Set(["USGS_MMI"]);
const KNOWN_INTENSITY_SCALES: ReadonlySet<string> = new Set(["MMI_X100"]);
const KNOWN_CELLS_GENERATION_METHODS: ReadonlySet<string> = new Set([
    "shakemap_gridxml_h3_grid_point_p90_v1",
    "shakemap_hdf_h3_area_weighted_p90_v1",
    "shakemap_gridxml_h3_center_bilinear_v1",
]);
