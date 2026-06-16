import { describe, expect, it } from "vitest";
import type { AffectedAreaTileManifest, AffectedCellTileFeature } from "./affected-area-tiles";
import {
    cellTileKeysForViewport,
    dedupeCellTileFeatures,
    parseAffectedAreaTileManifest,
    rasterTileUrlForManifest,
    selectAffectedAreaLayerModeForZoom,
    tileUrlFromTemplate,
} from "./affected-area-tiles";

const VALID_MANIFEST: AffectedAreaTileManifest = {
    kind: "tiled-affected-cells",
    eventUid: "0x" + "a".repeat(64),
    affectedCellsRoot: "0x" + "b".repeat(64),
    sourceSha256: "c".repeat(64),
    h3Resolution: 7,
    cellCount: 2,
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
    rasterTileKeys: ["6/56/24", "7/113/49"],
    cellTileKeys: ["11/1832/787", "11/1833/787"],
};

const FEATURE_A: AffectedCellTileFeature = {
    decimal: "608798163746160639",
    hex: "872e209a0ffffff",
    band: 2,
    boundary: [
        { lat: 38.27, lng: 140.87 },
        { lat: 38.28, lng: 140.88 },
    ],
    bounds: {
        north: 38.28,
        south: 38.27,
        east: 140.88,
        west: 140.87,
    },
};

const FEATURE_B: AffectedCellTileFeature = {
    decimal: "608795190286614527",
    hex: "872e00001ffffff",
    band: 3,
    boundary: [
        { lat: 39.54, lng: 143.6 },
        { lat: 39.55, lng: 143.61 },
    ],
    bounds: {
        north: 39.55,
        south: 39.54,
        east: 143.61,
        west: 143.6,
    },
};

describe("parseAffectedAreaTileManifest", () => {
    it("accepts a valid manifest", () => {
        expect(parseAffectedAreaTileManifest(VALID_MANIFEST)).toStrictEqual(VALID_MANIFEST);
    });

    it("fails closed for invalid manifest kind", () => {
        expect(parseAffectedAreaTileManifest({ ...VALID_MANIFEST, kind: "band-overlay-image" })).toBeNull();
    });

    it("fails closed for invalid sourceSha256", () => {
        expect(parseAffectedAreaTileManifest({ ...VALID_MANIFEST, sourceSha256: "not-sha" })).toBeNull();
    });

    it("fails closed for invalid tile template", () => {
        expect(
            parseAffectedAreaTileManifest({
                ...VALID_MANIFEST,
                rasterTileUrlTemplate: "/demo/tohoku-2011/raster/static.svg",
            }),
        ).toBeNull();
    });
});

describe("tile URL helpers", () => {
    it("builds URL from template", () => {
        expect(
            tileUrlFromTemplate("/demo/tohoku-2011/cells/{z}/{x}/{y}.json", {
                z: 11,
                x: 1832,
                y: 808,
            }),
        ).toBe("/demo/tohoku-2011/cells/11/1832/808.json");
    });

    it("returns raster tile URL for an existing key", () => {
        expect(rasterTileUrlForManifest(VALID_MANIFEST, { z: 6, x: 56, y: 24 })).toBe(
            "/demo/tohoku-2011/raster/6/56/24.svg",
        );
    });

    it("returns transparent tile for a missing raster key", () => {
        expect(rasterTileUrlForManifest(VALID_MANIFEST, { z: 6, x: 1, y: 1 })).toMatch(
            /^data:image\/svg\+xml,/u,
        );
    });
});

describe("cell tile selection and feature dedupe", () => {
    it("calculates existing cell tile keys from visible viewport", () => {
        const keys = cellTileKeysForViewport(VALID_MANIFEST, {
            north: 38.34,
            south: 38.2,
            east: 142.4,
            west: 142.1,
        });

        expect(keys).toEqual(["11/1832/787", "11/1833/787"]);
    });

    it("deduplicates duplicated features by decimal", () => {
        expect(dedupeCellTileFeatures([FEATURE_A, FEATURE_B, FEATURE_A])).toEqual([
            FEATURE_A,
            FEATURE_B,
        ]);
    });
});

describe("selectAffectedAreaLayerModeForZoom", () => {
    it("uses raster mode below minCellZoom", () => {
        expect(selectAffectedAreaLayerModeForZoom(10, VALID_MANIFEST)).toBe("raster");
    });

    it("uses cell mode at minCellZoom and above", () => {
        expect(selectAffectedAreaLayerModeForZoom(11, VALID_MANIFEST)).toBe("cells");
        expect(selectAffectedAreaLayerModeForZoom(13, VALID_MANIFEST)).toBe("cells");
    });
});
