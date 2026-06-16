import { readFile } from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "@sonari/proof-core";
import { describe, expect, it, vi } from "vitest";
import type { AffectedAreaR2Bucket, AffectedAreaR2PutOptions } from "./affected_area_r2.js";
import {
    summarizeAffectedAreaWorkflowInput,
    validateAffectedAreaWorkflowInput,
} from "./affected_area_workflow_input.js";

const VALID_AFFECTED_CELLS_JSON = JSON.stringify({
    event_uid: "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd",
    event_revision: 1,
    oracle_version: 1,
    geo_resolution: 7,
    cells_generation_method: "shakemap_gridxml_h3_grid_point_p90_v1",
    cell_metric: "USGS_MMI",
    cell_aggregation: "GRID_POINT_P90",
    intensity_scale: "MMI_X100",
    affected_cells: [
        { h3_index: "608819013513904127", intensity_value: 831, cell_band: 3 },
        { h3_index: "608819013597790207", intensity_value: 723, cell_band: 1 },
    ],
});
const VALID_BYTES = new TextEncoder().encode(VALID_AFFECTED_CELLS_JSON);

const VALID_INPUT = {
    event_uid: "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd",
    event_revision: 1,
    affected_cells_hash: sha256Hex(VALID_BYTES),
    affected_cells_root: "0x526e982479c985a009227facabf22c6d7633110fb1a15a743b453218f7f1890f",
    affected_cell_count: 2,
    geo_resolution: 7,
    affected_cells_uri: "walrus://blob/test-blob-id-001",
};

class FakeAffectedAreaR2Bucket implements AffectedAreaR2Bucket {
    readonly puts: Array<{
        readonly key: string;
        readonly value: string;
        readonly options: AffectedAreaR2PutOptions | undefined;
    }> = [];

    constructor(private readonly failOnKey?: string) {}

    async put(
        key: string,
        value: string,
        options?: AffectedAreaR2PutOptions,
    ): Promise<void> {
        if (this.failOnKey !== undefined && key.includes(this.failOnKey)) {
            throw new Error(`R2 put failed for ${key}`);
        }
        this.puts.push({ key, value, options });
    }
}

function makeWalrusFetch(bytes: Uint8Array): typeof fetch {
    return async (): Promise<Response> => {
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        return new Response(buffer, { status: 200 });
    };
}

describe("validateAffectedAreaWorkflowInput", () => {
    it("accepts the registration metadata used by the workflow", () => {
        expect(validateAffectedAreaWorkflowInput(VALID_INPUT)).toStrictEqual(VALID_INPUT);
    });

    it("rejects invalid payloads before any heavy work starts", () => {
        expect(() =>
            validateAffectedAreaWorkflowInput({ ...VALID_INPUT, geo_resolution: 8 }),
        ).toThrow(/geo_resolution/u);
        expect(() =>
            validateAffectedAreaWorkflowInput({
                ...VALID_INPUT,
                affected_cells_uri: "https://example.com/blob",
            }),
        ).toThrow(/walrus/u);
    });

    it("summarizes without returning large artifact bytes", () => {
        const summary = summarizeAffectedAreaWorkflowInput(
            validateAffectedAreaWorkflowInput(VALID_INPUT),
        );

        expect(summary).toStrictEqual({
            event_uid: VALID_INPUT.event_uid,
            event_revision: VALID_INPUT.event_revision,
            affected_cells_root: VALID_INPUT.affected_cells_root,
        });
        expect(new TextEncoder().encode(JSON.stringify(summary)).byteLength).toBeLessThan(1024);
    });
});

describe("AffectedAreaArtifactWorkflow", () => {
    it("re-fetches Walrus, validates metadata, and publishes affected-area artifacts to R2", async () => {
        const { runAffectedAreaArtifactWorkflow } = await import("./affected_area_workflow.js");
        const bucket = new FakeAffectedAreaR2Bucket();

        const summary = await runAffectedAreaArtifactWorkflow(
            validateAffectedAreaWorkflowInput(VALID_INPUT),
            {
                AFFECTED_AREA_ARTIFACTS: bucket,
                WALRUS_AGGREGATOR_URL: "https://walrus.example",
                SONARI_AFFECTED_AREA_BASE_URL: "https://affected-area.example/",
            },
            makeWalrusFetch(VALID_BYTES),
        );

        expect(summary).toMatchObject({
            event_uid: VALID_INPUT.event_uid,
            event_revision: VALID_INPUT.event_revision,
            affected_cells_root: VALID_INPUT.affected_cells_root,
            manifest_r2_key:
                "affected-area/events/0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd/revisions/1/affected-area-manifest.json",
        });
        expect(summary.object_count).toBe(bucket.puts.length);
        expect(bucket.puts.length).toBeGreaterThan(3);
        expect(bucket.puts.at(-1)?.key).toBe(summary.manifest_r2_key);
        expect(bucket.puts.at(-1)?.value).toContain(
            '"rasterTileUrlTemplate":"https://affected-area.example/affected-area/events/',
        );
        expect(new TextEncoder().encode(JSON.stringify(summary)).byteLength).toBeLessThan(1024);
    });

    it("uses NonRetryableError for metadata mismatches before any R2 write", async () => {
        const NonRetryableError = class extends Error {};
        vi.stubGlobal("NonRetryableError", NonRetryableError);
        const { runAffectedAreaArtifactWorkflow } = await import("./affected_area_workflow.js");
        const bucket = new FakeAffectedAreaR2Bucket();

        await expect(
            runAffectedAreaArtifactWorkflow(
                validateAffectedAreaWorkflowInput({
                    ...VALID_INPUT,
                    affected_cells_hash: `0x${"12".repeat(32)}`,
                }),
                {
                    AFFECTED_AREA_ARTIFACTS: bucket,
                    WALRUS_AGGREGATOR_URL: "https://walrus.example",
                    SONARI_AFFECTED_AREA_BASE_URL: "https://affected-area.example",
                },
                makeWalrusFetch(VALID_BYTES),
            ),
        ).rejects.toBeInstanceOf(NonRetryableError);

        expect(bucket.puts).toHaveLength(0);
        vi.unstubAllGlobals();
    });

    it("keeps R2 failures retryable and does not save the manifest first", async () => {
        const NonRetryableError = class extends Error {};
        vi.stubGlobal("NonRetryableError", NonRetryableError);
        const { runAffectedAreaArtifactWorkflow } = await import("./affected_area_workflow.js");
        const bucket = new FakeAffectedAreaR2Bucket("raster/");

        await expect(
            runAffectedAreaArtifactWorkflow(
                validateAffectedAreaWorkflowInput(VALID_INPUT),
                {
                    AFFECTED_AREA_ARTIFACTS: bucket,
                    WALRUS_AGGREGATOR_URL: "https://walrus.example",
                    SONARI_AFFECTED_AREA_BASE_URL: "https://affected-area.example",
                },
                makeWalrusFetch(VALID_BYTES),
            ),
        ).rejects.not.toBeInstanceOf(NonRetryableError);

        expect(bucket.puts.map((put) => put.key)).not.toContain(
            "affected-area/events/0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd/revisions/1/affected-area-manifest.json",
        );
        vi.unstubAllGlobals();
    });

    it("is exported as the class named by wrangler.toml", async () => {
        vi.stubGlobal("WorkflowEntrypoint", class {});
        vi.stubGlobal("NonRetryableError", Error);

        const [{ AffectedAreaArtifactWorkflow }, wranglerToml] = await Promise.all([
            import("./affected_area_workflow.js"),
            readFile(path.join(process.cwd(), "wrangler.toml"), "utf8"),
        ]);

        expect(AffectedAreaArtifactWorkflow.name).toBe("AffectedAreaArtifactWorkflow");
        expect(wranglerToml).toContain('binding = "AFFECTED_AREA_ARTIFACT_WORKFLOW"');
        expect(wranglerToml).toContain('name = "sonari-affected-area-artifact-workflow"');
        expect(wranglerToml).toContain('class_name = "AffectedAreaArtifactWorkflow"');
    });
});
