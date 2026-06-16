import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAffectedAreaR2UploadPlan } from "./upload_demo_affected_area_r2.js";

let tempDir: string | null = null;

afterEach(async () => {
    if (tempDir !== null) {
        await rm(tempDir, { recursive: true, force: true });
        tempDir = null;
    }
});

async function createOutputDir(): Promise<string> {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "sonari-affected-area-upload-"));
    const outputDir = path.join(tempDir, "output");
    await mkdir(path.join(outputDir, "raster", "6", "56"), { recursive: true });
    await mkdir(path.join(outputDir, "cells", "11", "1832"), { recursive: true });
    await writeFile(path.join(outputDir, "affected-area-manifest.json"), "{}", "utf8");
    await writeFile(path.join(outputDir, "affected-cells.json"), "[]", "utf8");
    await writeFile(path.join(outputDir, "raster", "6", "56", "24.svg"), "<svg/>", "utf8");
    await writeFile(path.join(outputDir, "cells", "11", "1832", "787.json"), "{}", "utf8");
    return outputDir;
}

describe("buildAffectedAreaR2UploadPlan", () => {
    it("builds Wrangler R2 object put targets for every staged file", async () => {
        const outputDir = await createOutputDir();
        const plan = await buildAffectedAreaR2UploadPlan({
            bucket: "sonari-affected-area-tiles-v1",
            outputDir,
            objectPrefix: "affected-area/events/0xabc/revisions/1",
        });

        expect(plan.map((item) => item.objectPath)).toStrictEqual([
            "sonari-affected-area-tiles-v1/affected-area/events/0xabc/revisions/1/affected-area-manifest.json",
            "sonari-affected-area-tiles-v1/affected-area/events/0xabc/revisions/1/affected-cells.json",
            "sonari-affected-area-tiles-v1/affected-area/events/0xabc/revisions/1/cells/11/1832/787.json",
            "sonari-affected-area-tiles-v1/affected-area/events/0xabc/revisions/1/raster/6/56/24.svg",
        ]);
        expect(plan.map((item) => item.contentType)).toStrictEqual([
            "application/json",
            "application/json",
            "application/json",
            "image/svg+xml",
        ]);
        expect(new Set(plan.map((item) => item.cacheControl))).toStrictEqual(
            new Set(["public, max-age=31536000, immutable"]),
        );
    });
});
