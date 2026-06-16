import {
    type GeneratedAffectedAreaArtifacts,
    tileOutputRelativePath,
} from "./affected_area_artifacts.js";

export const AFFECTED_AREA_ARTIFACT_CACHE_CONTROL = "public, max-age=31536000, immutable";

export interface AffectedAreaR2PutOptions {
    readonly httpMetadata?: {
        readonly contentType?: string;
        readonly cacheControl?: string;
    };
}

export interface AffectedAreaR2Bucket {
    put(key: string, value: string, options?: AffectedAreaR2PutOptions): Promise<unknown>;
}

export interface PublishAffectedAreaArtifactsParams {
    readonly bucket: AffectedAreaR2Bucket;
    readonly artifacts: GeneratedAffectedAreaArtifacts;
    readonly eventRevision: number;
}

export interface PublishAffectedAreaArtifactsResult {
    readonly objectKeys: readonly string[];
}

export function affectedAreaObjectPrefix(eventUid: string, eventRevision: number): string {
    return `affected-area/events/${eventUid}/revisions/${eventRevision}`;
}

export function affectedAreaManifestR2Key(eventUid: string, eventRevision: number): string {
    return `${affectedAreaObjectPrefix(eventUid, eventRevision)}/affected-area-manifest.json`;
}

function contentTypeForKind(kind: "json" | "svg"): string {
    return kind === "json" ? "application/json" : "image/svg+xml";
}

function putOptions(kind: "json" | "svg"): AffectedAreaR2PutOptions {
    return {
        httpMetadata: {
            contentType: contentTypeForKind(kind),
            cacheControl: AFFECTED_AREA_ARTIFACT_CACHE_CONTROL,
        },
    };
}

async function putArtifact(
    bucket: AffectedAreaR2Bucket,
    key: string,
    value: string,
    kind: "json" | "svg",
): Promise<string> {
    await bucket.put(key, value, putOptions(kind));
    return key;
}

function tileObjectKey(
    prefix: string,
    directory: "raster" | "cells",
    tileKey: string,
): string {
    return `${prefix}/${tileOutputRelativePath(directory, tileKey).join("/")}`;
}

export async function publishAffectedAreaArtifacts(
    params: PublishAffectedAreaArtifactsParams,
): Promise<PublishAffectedAreaArtifactsResult> {
    const { artifacts, bucket } = params;
    const objectPrefix = affectedAreaObjectPrefix(artifacts.manifest.eventUid, params.eventRevision);
    const objectKeys: string[] = [];

    objectKeys.push(
        await putArtifact(
            bucket,
            `${objectPrefix}/affected-cells.json`,
            artifacts.affectedCellsJson,
            "json",
        ),
    );

    for (const [key, content] of artifacts.rasterTiles) {
        objectKeys.push(
            await putArtifact(bucket, tileObjectKey(objectPrefix, "raster", key), content, "svg"),
        );
    }

    for (const [key, content] of artifacts.cellTiles) {
        objectKeys.push(
            await putArtifact(bucket, tileObjectKey(objectPrefix, "cells", key), content, "json"),
        );
    }

    objectKeys.push(
        await putArtifact(
            bucket,
            `${objectPrefix}/affected-area-manifest.json`,
            JSON.stringify(artifacts.manifest),
            "json",
        ),
    );

    return { objectKeys };
}
