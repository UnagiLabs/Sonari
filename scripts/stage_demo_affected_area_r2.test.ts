import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AffectedAreaTileManifest } from "../dapp/app/claim/affected-area/affected-area-tiles.js";
import { stageAffectedAreaR2Artifacts } from "./stage_demo_affected_area_r2.js";

const EVENT_UID = `0x${"12".repeat(32)}`;
const AFFECTED_CELLS_ROOT = `0x${"34".repeat(32)}`;

const MANIFEST: AffectedAreaTileManifest = {
    kind: "tiled-affected-cells",
    eventUid: EVENT_UID,
    affectedCellsRoot: AFFECTED_CELLS_ROOT,
    sourceSha256: "a".repeat(64),
    h3Resolution: 7,
    cellCount: 1,
    bounds: {
        north: 40,
        south: 35,
        east: 145,
        west: 139,
    },
    styleVersion: 1,
    minRasterZoom: 6,
    maxRasterZoom: 10,
    minCellZoom: 11,
    cellTileZoom: 11,
    tileSize: 256,
    rasterTileUrlTemplate: "/demo/tohoku-2011/raster/{z}/{x}/{y}.svg",
    cellTileUrlTemplate: "/demo/tohoku-2011/cells/{z}/{x}/{y}.json",
    rasterTileKeys: ["6/56/24"],
    cellTileKeys: ["11/1832/787"],
};

let tempDir: string | null = null;

afterEach(async () => {
    if (tempDir !== null) {
        await rm(tempDir, { recursive: true, force: true });
        tempDir = null;
    }
});

async function createInputDir(): Promise<string> {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "sonari-affected-area-r2-"));
    const inputDir = path.join(tempDir, "input");
    await mkdir(path.join(inputDir, "raster", "6", "56"), { recursive: true });
    await mkdir(path.join(inputDir, "cells", "11", "1832"), { recursive: true });
    await writeFile(
        path.join(inputDir, "affected-cells.json"),
        '[{"decimal":"1","band":1}]',
        "utf8",
    );
    await writeFile(
        path.join(inputDir, "affected-area-manifest.json"),
        JSON.stringify(MANIFEST),
        "utf8",
    );
    await writeFile(path.join(inputDir, "raster", "6", "56", "24.svg"), "<svg/>", "utf8");
    await writeFile(
        path.join(inputDir, "cells", "11", "1832", "787.json"),
        '{"features":[]}',
        "utf8",
    );
    return inputDir;
}

function requireTempDir(): string {
    if (tempDir === null) {
        throw new Error("tempDir was not initialized");
    }
    return tempDir;
}

describe("stageAffectedAreaR2Artifacts", () => {
    it("copies affected-area artifacts and rewrites only URL templates for R2", async () => {
        const inputDir = await createInputDir();
        const outputDir = path.join(requireTempDir(), "output");

        const result = await stageAffectedAreaR2Artifacts({
            inputDir,
            outputDir,
            baseUrl: "https://affected-area-assets.sonari.help/",
            eventRevision: 3,
        });

        expect(result.manifest).toMatchObject({
            sourceSha256: MANIFEST.sourceSha256,
            cellCount: MANIFEST.cellCount,
            bounds: MANIFEST.bounds,
            rasterTileKeys: MANIFEST.rasterTileKeys,
            cellTileKeys: MANIFEST.cellTileKeys,
        });
        expect(result.manifest.rasterTileUrlTemplate).toBe(
            `https://affected-area-assets.sonari.help/affected-area/events/${EVENT_UID}/revisions/3/raster/{z}/{x}/{y}.svg`,
        );
        expect(result.manifest.cellTileUrlTemplate).toBe(
            `https://affected-area-assets.sonari.help/affected-area/events/${EVENT_UID}/revisions/3/cells/{z}/{x}/{y}.json`,
        );

        await expect(readFile(path.join(outputDir, "affected-cells.json"), "utf8")).resolves.toBe(
            '[{"decimal":"1","band":1}]',
        );
        await expect(
            readFile(path.join(outputDir, "raster", "6", "56", "24.svg"), "utf8"),
        ).resolves.toBe("<svg/>");
        await expect(
            readFile(path.join(outputDir, "cells", "11", "1832", "787.json"), "utf8"),
        ).resolves.toBe('{"features":[]}');

        const stagedManifest = JSON.parse(
            await readFile(path.join(outputDir, "affected-area-manifest.json"), "utf8"),
        ) as unknown;
        expect(stagedManifest).toStrictEqual(result.manifest);
    });

    it("fails closed when base URL is empty", async () => {
        const inputDir = await createInputDir();

        await expect(
            stageAffectedAreaR2Artifacts({
                inputDir,
                outputDir: path.join(requireTempDir(), "output"),
                baseUrl: "",
                eventRevision: 1,
            }),
        ).rejects.toThrow("baseUrl is required");
    });
});
