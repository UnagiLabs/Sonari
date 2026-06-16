import { describe, expect, it } from "vitest";
import {
    affectedAreaArtifactFromBaseUrl,
    affectedAreaManifestPath,
    affectedAreaR2ObjectPrefix,
    affectedAreaTileUrlTemplate,
    normalizeAffectedAreaBaseUrl,
} from "./affected-area-artifact";

const LOCATION = {
    eventUid: `0x${"ab".repeat(32)}`,
    eventRevision: 3,
};

describe("affected area R2 artifact helpers", () => {
    it("normalizes base URL by trimming trailing slashes", () => {
        expect(normalizeAffectedAreaBaseUrl(" https://assets.example.com/// ")).toBe(
            "https://assets.example.com",
        );
    });

    it("returns null for empty base URL", () => {
        expect(normalizeAffectedAreaBaseUrl(" ")).toBeNull();
        expect(affectedAreaArtifactFromBaseUrl("", LOCATION)).toBeNull();
    });

    it("builds deterministic object prefix and manifest URL", () => {
        expect(affectedAreaR2ObjectPrefix(LOCATION)).toBe(
            `affected-area/events/${LOCATION.eventUid}/revisions/3`,
        );
        expect(affectedAreaManifestPath("https://assets.example.com", LOCATION)).toBe(
            `https://assets.example.com/affected-area/events/${LOCATION.eventUid}/revisions/3/affected-area-manifest.json`,
        );
    });

    it("builds raster and cell tile URL templates", () => {
        expect(affectedAreaTileUrlTemplate("https://assets.example.com", LOCATION, "raster")).toBe(
            `https://assets.example.com/affected-area/events/${LOCATION.eventUid}/revisions/3/raster/{z}/{x}/{y}.svg`,
        );
        expect(affectedAreaTileUrlTemplate("https://assets.example.com", LOCATION, "cells")).toBe(
            `https://assets.example.com/affected-area/events/${LOCATION.eventUid}/revisions/3/cells/{z}/{x}/{y}.json`,
        );
    });

    it("creates tiled affected-area artifact source from configured base URL", () => {
        expect(affectedAreaArtifactFromBaseUrl("https://assets.example.com/", LOCATION)).toEqual({
            kind: "tiled-affected-cells",
            manifestPath: `https://assets.example.com/affected-area/events/${LOCATION.eventUid}/revisions/3/affected-area-manifest.json`,
        });
    });
});
