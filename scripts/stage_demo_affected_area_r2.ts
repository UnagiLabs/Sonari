import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    affectedAreaTileUrlTemplate,
    normalizeAffectedAreaBaseUrl,
} from "../dapp/app/claim/affected-area/affected-area-artifact.js";
import {
    type AffectedAreaTileManifest,
    parseAffectedAreaTileManifest,
} from "../dapp/app/claim/affected-area/affected-area-tiles.js";

const DEFAULT_INPUT_DIR = "dapp/public/demo/tohoku-2011";
const DEFAULT_OUTPUT_DIR = ".build/affected-area-r2/tohoku-2011";
const DEFAULT_EVENT_REVISION = 1;

export interface StageAffectedAreaR2ArtifactsParams {
    readonly inputDir: string;
    readonly outputDir: string;
    readonly baseUrl: string;
    readonly eventRevision: number;
}

export interface StagedAffectedAreaR2Artifacts {
    readonly outputDir: string;
    readonly manifest: AffectedAreaTileManifest;
}

function parsePositiveInteger(name: string, value: string | undefined): number {
    const raw = value?.trim();
    if (raw === undefined || raw.length === 0) {
        throw new Error(`${name} is required`);
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
}

async function loadManifest(inputDir: string): Promise<AffectedAreaTileManifest> {
    const raw = await readFile(path.join(inputDir, "affected-area-manifest.json"), "utf8");
    const parsed = parseAffectedAreaTileManifest(JSON.parse(raw) as unknown);
    if (parsed === null) {
        throw new Error("affected-area-manifest.json is invalid");
    }
    return parsed;
}

export async function stageAffectedAreaR2Artifacts(
    params: StageAffectedAreaR2ArtifactsParams,
): Promise<StagedAffectedAreaR2Artifacts> {
    const baseUrl = normalizeAffectedAreaBaseUrl(params.baseUrl);
    if (baseUrl === null) {
        throw new Error("baseUrl is required");
    }
    if (!Number.isInteger(params.eventRevision) || params.eventRevision < 1) {
        throw new Error("eventRevision must be a positive integer");
    }

    const sourceManifest = await loadManifest(params.inputDir);
    const location = {
        eventUid: sourceManifest.eventUid,
        eventRevision: params.eventRevision,
    };
    const stagedManifest: AffectedAreaTileManifest = {
        ...sourceManifest,
        rasterTileUrlTemplate: affectedAreaTileUrlTemplate(baseUrl, location, "raster"),
        cellTileUrlTemplate: affectedAreaTileUrlTemplate(baseUrl, location, "cells"),
    };

    await rm(params.outputDir, { recursive: true, force: true });
    await mkdir(path.dirname(params.outputDir), { recursive: true });
    await cp(params.inputDir, params.outputDir, { recursive: true });
    await writeFile(
        path.join(params.outputDir, "affected-area-manifest.json"),
        JSON.stringify(stagedManifest),
        "utf8",
    );

    return {
        outputDir: params.outputDir,
        manifest: stagedManifest,
    };
}

async function main(): Promise<void> {
    const inputDir = process.env.SONARI_AFFECTED_AREA_INPUT_DIR?.trim() || DEFAULT_INPUT_DIR;
    const outputDir = process.env.SONARI_AFFECTED_AREA_R2_STAGE_DIR?.trim() || DEFAULT_OUTPUT_DIR;
    const baseUrl = process.env.NEXT_PUBLIC_SONARI_AFFECTED_AREA_BASE_URL;
    const eventRevision = parsePositiveInteger(
        "SONARI_AFFECTED_AREA_EVENT_REVISION",
        process.env.SONARI_AFFECTED_AREA_EVENT_REVISION ?? String(DEFAULT_EVENT_REVISION),
    );

    const result = await stageAffectedAreaR2Artifacts({
        inputDir,
        outputDir,
        baseUrl: baseUrl ?? "",
        eventRevision,
    });

    process.stdout.write(
        [
            `staged affected-area R2 artifacts: ${result.outputDir}`,
            `eventUid: ${result.manifest.eventUid}`,
            `eventRevision: ${eventRevision}`,
            `rasterTileUrlTemplate: ${result.manifest.rasterTileUrlTemplate}`,
            `cellTileUrlTemplate: ${result.manifest.cellTileUrlTemplate}`,
        ].join("\n"),
    );
    process.stdout.write("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    });
}
