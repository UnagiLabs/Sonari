/**
 * proof_artifacts.test.ts
 *
 * manifest / shard entry の parse と、entry 検索・配信レスポンス整形のテスト。
 * proof-core の findProofEntry / shapeProofResponse は存在しないため自前実装を検証する。
 * bigint フィールド（h3_index / oracle_version）は JSON 保存時に string 形式にする。
 */
import { describe, expect, it } from "vitest";
import {
    type AffectedCellsProofManifest,
    type AffectedCellsProofShardEntry,
    findShardEntry,
    parseProofManifest,
    parseShardEntry,
    shapeProofResponse,
} from "./proof_artifacts.js";
import type { ProofStep } from "@sonari/proof-core";

// ---------------------------------------------------------------------------
// テスト用フィクスチャ
// ---------------------------------------------------------------------------

const VALID_EVENT_UID =
    "0x0000000000000000000000000000000000000000000000000000000000000001";
const VALID_ROOT =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VALID_LEAF_HASH =
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const VALID_SHARD_HASH =
    "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

/** 最小限の有効な manifest JSON オブジェクト */
function makeValidManifest(): Record<string, unknown> {
    return {
        schema_version: 1,
        event_uid: VALID_EVENT_UID,
        event_revision: 1,
        affected_cells_uri: "walrus://blob/abc123",
        affected_cells_hash: VALID_ROOT,
        affected_cells_root: VALID_ROOT,
        affected_cell_count: 2,
        geo_resolution: 7,
        shards: [
            {
                shard_key: "0",
                r2_key: "events/0x0001/rev1/shards/0.json",
                hash: VALID_SHARD_HASH,
                cell_count: 2,
            },
        ],
    };
}

/** 最小限の有効な shard entry JSON オブジェクト */
function makeValidShardEntry(h3Index = "613196570282450943"): Record<string, unknown> {
    return {
        event_uid: VALID_EVENT_UID,
        event_revision: 1,
        geo_resolution: 7,
        h3_index: h3Index, // string 形式で保存（bigint JSON 非対応のため）
        cell_band: 1,
        intensity_value: 300,
        cell_metric: "USGS_MMI",
        intensity_scale: "MMI_X100",
        cells_generation_method: "shakemap_gridxml_h3_grid_point_p90_v1",
        oracle_version: "1", // string 形式で保存
        leaf_hash: VALID_LEAF_HASH,
        proof: [
            {
                sibling_on_left: false,
                sibling_hash: VALID_SHARD_HASH,
            },
        ],
    };
}

// ---------------------------------------------------------------------------
// parseProofManifest
// ---------------------------------------------------------------------------

describe("parseProofManifest", () => {
    describe("正常系", () => {
        it("有効な manifest を parse して型付きオブジェクトを返す", () => {
            const raw = makeValidManifest();
            const result = parseProofManifest(raw);

            expect(result.schema_version).toBe(1);
            expect(result.event_uid).toBe(VALID_EVENT_UID);
            expect(result.event_revision).toBe(1);
            expect(result.affected_cells_uri).toBe("walrus://blob/abc123");
            expect(result.affected_cells_hash).toBe(VALID_ROOT);
            expect(result.affected_cells_root).toBe(VALID_ROOT);
            expect(result.affected_cell_count).toBe(2);
            expect(result.geo_resolution).toBe(7);
            expect(result.shards).toHaveLength(1);
            expect(result.shards[0]).toMatchObject({
                shard_key: "0",
                r2_key: "events/0x0001/rev1/shards/0.json",
                hash: VALID_SHARD_HASH,
                cell_count: 2,
            });
        });
    });

    describe("必須キー欠落 → throw", () => {
        const requiredKeys = [
            "schema_version",
            "event_uid",
            "event_revision",
            "affected_cells_uri",
            "affected_cells_hash",
            "affected_cells_root",
            "affected_cell_count",
            "geo_resolution",
            "shards",
        ];

        it.each(requiredKeys)("フィールド %s が欠落すると throw する", (key) => {
            const raw = makeValidManifest();
            delete (raw as Record<string, unknown>)[key];
            expect(() => parseProofManifest(raw)).toThrow();
        });
    });

    describe("不正な hex → throw", () => {
        it("affected_cells_hash が 0x プレフィックス無しの場合 throw する", () => {
            const raw = makeValidManifest();
            raw.affected_cells_hash = "aabbcc";
            expect(() => parseProofManifest(raw)).toThrow();
        });

        it("event_uid が短い hex 文字列の場合 throw する", () => {
            const raw = makeValidManifest();
            raw.event_uid = "0x1234";
            expect(() => parseProofManifest(raw)).toThrow();
        });

        it("affected_cells_root が大文字を含む場合 throw する（小文字強制）", () => {
            const raw = makeValidManifest();
            raw.affected_cells_root =
                "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
            expect(() => parseProofManifest(raw)).toThrow();
        });
    });

    describe("型不正 → throw", () => {
        it("schema_version が文字列の場合 throw する", () => {
            const raw = makeValidManifest();
            raw.schema_version = "1";
            expect(() => parseProofManifest(raw)).toThrow();
        });

        it("event_revision が負の数の場合 throw する", () => {
            const raw = makeValidManifest();
            raw.event_revision = -1;
            expect(() => parseProofManifest(raw)).toThrow();
        });

        it("shards が配列でない場合 throw する", () => {
            const raw = makeValidManifest();
            raw.shards = "not-an-array";
            expect(() => parseProofManifest(raw)).toThrow();
        });

        it("shard エントリに hash フィールドが欠落すると throw する", () => {
            const raw = makeValidManifest();
            (raw.shards as Record<string, unknown>[])[0] = {
                shard_key: "0",
                r2_key: "some/key",
                // hash 欠落
                cell_count: 1,
            };
            expect(() => parseProofManifest(raw)).toThrow();
        });
    });
});

// ---------------------------------------------------------------------------
// parseShardEntry
// ---------------------------------------------------------------------------

describe("parseShardEntry", () => {
    describe("正常系", () => {
        it("有効な shard entry を parse して型付きオブジェクトを返す", () => {
            const raw = makeValidShardEntry();
            const result = parseShardEntry(raw);

            expect(result.event_uid).toBe(VALID_EVENT_UID);
            expect(result.event_revision).toBe(1);
            expect(result.geo_resolution).toBe(7);
            // h3_index は string → bigint に復元
            expect(result.h3_index).toBe(613196570282450943n);
            expect(result.cell_band).toBe(1);
            expect(result.intensity_value).toBe(300);
            expect(result.cell_metric).toBe("USGS_MMI");
            expect(result.intensity_scale).toBe("MMI_X100");
            expect(result.cells_generation_method).toBe(
                "shakemap_gridxml_h3_grid_point_p90_v1",
            );
            // oracle_version は string → bigint に復元
            expect(result.oracle_version).toBe(1n);
            expect(result.leaf_hash).toBe(VALID_LEAF_HASH);
            expect(result.proof).toHaveLength(1);
            expect(result.proof[0]).toMatchObject({
                sibling_on_left: false,
                sibling_hash: VALID_SHARD_HASH,
            });
        });

        it("H3 center bilinear の cells_generation_method を受け入れる", () => {
            const raw = makeValidShardEntry();
            raw.cells_generation_method = "shakemap_gridxml_h3_center_bilinear_v1";

            const result = parseShardEntry(raw);

            expect(result.cells_generation_method).toBe(
                "shakemap_gridxml_h3_center_bilinear_v1",
            );
        });
    });

    describe("leaf フィールド欠落 → throw", () => {
        const leafFields = [
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
        ];

        it.each(leafFields)("フィールド %s が欠落すると throw する", (key) => {
            const raw = makeValidShardEntry();
            delete (raw as Record<string, unknown>)[key];
            expect(() => parseShardEntry(raw)).toThrow();
        });
    });

    describe("proof 形式不正 → throw", () => {
        it("proof 要素に sibling_on_left が欠落すると throw する", () => {
            const raw = makeValidShardEntry();
            raw.proof = [{ sibling_hash: VALID_SHARD_HASH }];
            expect(() => parseShardEntry(raw)).toThrow();
        });

        it("proof 要素に sibling_hash が欠落すると throw する", () => {
            const raw = makeValidShardEntry();
            raw.proof = [{ sibling_on_left: false }];
            expect(() => parseShardEntry(raw)).toThrow();
        });

        it("sibling_hash が不正な hex 文字列の場合 throw する", () => {
            const raw = makeValidShardEntry();
            raw.proof = [{ sibling_on_left: false, sibling_hash: "invalid-hash" }];
            expect(() => parseShardEntry(raw)).toThrow();
        });
    });

    describe("bigint フィールドの型不正 → throw", () => {
        it("h3_index が数値（number）の場合 throw する（string 形式必須）", () => {
            const raw = makeValidShardEntry();
            raw.h3_index = 613196570282450943; // number ではなく string 必須
            expect(() => parseShardEntry(raw)).toThrow();
        });

        it("oracle_version が数値（number）の場合 throw する（string 形式必須）", () => {
            const raw = makeValidShardEntry();
            raw.oracle_version = 1; // number ではなく string 必須
            expect(() => parseShardEntry(raw)).toThrow();
        });

        it("h3_index が有効な decimal string でない場合 throw する", () => {
            const raw = makeValidShardEntry();
            raw.h3_index = "not-a-number";
            expect(() => parseShardEntry(raw)).toThrow();
        });
    });
});

// ---------------------------------------------------------------------------
// findShardEntry
// ---------------------------------------------------------------------------

describe("findShardEntry", () => {
    const entry1 = makeValidShardEntry("613196570282450943");
    const entry2 = makeValidShardEntry("613196570282451000");

    it("h3_index が一致する entry を返す", () => {
        const entries = [entry1, entry2].map(parseShardEntry);
        const result = findShardEntry(entries, 613196570282450943n);
        expect(result).not.toBeNull();
        expect(result?.h3_index).toBe(613196570282450943n);
    });

    it("h3_index が見つからない場合 null を返す", () => {
        const entries = [entry1].map(parseShardEntry);
        const result = findShardEntry(entries, 999999999999999999n);
        expect(result).toBeNull();
    });

    it("entries が空の場合 null を返す", () => {
        const result = findShardEntry([], 613196570282450943n);
        expect(result).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// shapeProofResponse
// ---------------------------------------------------------------------------

describe("shapeProofResponse", () => {
    it("entry と manifest から配信レスポンスを組み立てる", () => {
        const manifest: AffectedCellsProofManifest = parseProofManifest(makeValidManifest());
        const entry: AffectedCellsProofShardEntry = parseShardEntry(makeValidShardEntry());

        const response = shapeProofResponse(entry, manifest);

        expect(response.event_uid).toBe(VALID_EVENT_UID);
        expect(response.event_revision).toBe(1);
        // h3_index は decimal string で返す（JSON 互換）
        expect(response.h3_index).toBe("613196570282450943");
        expect(response.affected_cells_root).toBe(VALID_ROOT);
        expect(response.leaf).toBeDefined();
        // leaf に AffectedCellLeaf 全フィールドが含まれること
        expect(response.leaf.event_uid).toBe(VALID_EVENT_UID);
        expect(response.leaf.event_revision).toBe(1);
        expect(response.leaf.h3_index).toBe(613196570282450943n);
        expect(response.leaf.geo_resolution).toBe(7);
        expect(response.leaf.cell_band).toBe(1);
        expect(response.leaf.intensity_value).toBe(300);
        expect(response.leaf.cell_metric).toBe("USGS_MMI");
        expect(response.leaf.intensity_scale).toBe("MMI_X100");
        expect(response.leaf.cells_generation_method).toBe(
            "shakemap_gridxml_h3_grid_point_p90_v1",
        );
        expect(response.leaf.oracle_version).toBe(1n);
        // proof が配列
        expect(response.proof).toHaveLength(1);
        expect(response.proof[0]).toMatchObject({
            sibling_on_left: false,
            sibling_hash: VALID_SHARD_HASH,
        });
    });

    it("複数ステップの proof も正しく渡す", () => {
        const rawEntry = makeValidShardEntry();
        rawEntry.proof = [
            { sibling_on_left: false, sibling_hash: VALID_SHARD_HASH },
            { sibling_on_left: true, sibling_hash: VALID_ROOT },
        ] as ProofStep[];
        const entry = parseShardEntry(rawEntry);
        const manifest = parseProofManifest(makeValidManifest());
        const response = shapeProofResponse(entry, manifest);

        expect(response.proof).toHaveLength(2);
        expect(response.proof[1]).toMatchObject({
            sibling_on_left: true,
            sibling_hash: VALID_ROOT,
        });
    });
});
