import type { AffectedAreaArtifactSource } from "../catalog/claimable-program";

export const AFFECTED_AREA_R2_PREFIX = "affected-area/events";
export const AFFECTED_AREA_MANIFEST_FILE = "affected-area-manifest.json";

export interface AffectedAreaArtifactLocation {
    readonly eventUid: string;
    readonly eventRevision: number;
}

export function normalizeAffectedAreaBaseUrl(value: string | undefined): string | null {
    const trimmed = value?.trim() ?? "";
    if (trimmed.length === 0) {
        return null;
    }
    return trimmed.replace(/\/+$/u, "");
}

export function affectedAreaR2ObjectPrefix(input: AffectedAreaArtifactLocation): string {
    return `${AFFECTED_AREA_R2_PREFIX}/${input.eventUid}/revisions/${input.eventRevision}`;
}

export function affectedAreaManifestPath(
    baseUrl: string,
    input: AffectedAreaArtifactLocation,
): string {
    return `${baseUrl}/${affectedAreaR2ObjectPrefix(input)}/${AFFECTED_AREA_MANIFEST_FILE}`;
}

export function affectedAreaTileUrlTemplate(
    baseUrl: string,
    input: AffectedAreaArtifactLocation,
    kind: "raster" | "cells",
): string {
    const extension = kind === "raster" ? "svg" : "json";
    return `${baseUrl}/${affectedAreaR2ObjectPrefix(input)}/${kind}/{z}/{x}/{y}.${extension}`;
}

export function affectedAreaArtifactFromBaseUrl(
    baseUrl: string | undefined,
    input: AffectedAreaArtifactLocation,
): AffectedAreaArtifactSource | null {
    const normalized = normalizeAffectedAreaBaseUrl(baseUrl);
    if (normalized === null) {
        return null;
    }
    return {
        kind: "tiled-affected-cells",
        manifestPath: affectedAreaManifestPath(normalized, input),
    };
}
