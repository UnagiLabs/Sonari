import { describe, expect, it } from "vitest";
import type { GeneratedAffectedAreaArtifacts } from "./affected_area_artifacts.js";
import {
    AFFECTED_AREA_ARTIFACT_CACHE_CONTROL,
    affectedAreaManifestR2Key,
    affectedAreaObjectPrefix,
    publishAffectedAreaArtifacts,
    type AffectedAreaR2Bucket,
    type AffectedAreaR2PutOptions,
} from "./affected_area_r2.js";

const EVENT_UID = "0xabc";
const EVENT_REVISION = 3;
const ROOT = `0x${"11".repeat(32)}`;

class FakeAffectedAreaR2Bucket implements AffectedAreaR2Bucket {
    readonly puts: Array<{
        readonly key: string;
        readonly value: string;
        readonly options: AffectedAreaR2PutOptions | undefined;
    }> = [];

    constructor(private readonly failKey: string | null = null) {}

    async put(
        key: string,
        value: string,
        options?: AffectedAreaR2PutOptions,
    ): Promise<void> {
        if (key === this.failKey) {
            throw new Error(`put failed: ${key}`);
        }
        this.puts.push({ key, value, options });
    }
}

function makeArtifacts(): GeneratedAffectedAreaArtifacts {
    return {
        affectedCellsJson: '{"affected_cells":[]}',
        manifest: {
            kind: "tiled-affected-cells",
            eventUid: EVENT_UID,
            affectedCellsRoot: ROOT,
            sourceSha256: "a".repeat(64),
            h3Resolution: 7,
            cellCount: 0,
            bounds: { north: 1, south: 0, east: 1, west: 0 },
            styleVersion: 1,
            minRasterZoom: 6,
            maxRasterZoom: 10,
            minCellZoom: 11,
            cellTileZoom: 11,
            tileSize: 256,
            rasterTileUrlTemplate:
                "https://assets.example/affected-area/events/0xabc/revisions/3/raster/{z}/{x}/{y}.svg",
            cellTileUrlTemplate:
                "https://assets.example/affected-area/events/0xabc/revisions/3/cells/{z}/{x}/{y}.json",
            rasterTileKeys: ["6/56/24", "7/113/49"],
            cellTileKeys: ["11/1832/808"],
        },
        rasterTiles: new Map([
            ["6/56/24", "<svg/>"],
            ["7/113/49", "<svg/>"],
        ]),
        cellTiles: new Map([["11/1832/808", '{"features":[]}']]),
    };
}

describe("affectedAreaObjectPrefix", () => {
    it("builds the production affected-area prefix", () => {
        expect(affectedAreaObjectPrefix(EVENT_UID, EVENT_REVISION)).toBe(
            `affected-area/events/${EVENT_UID}/revisions/${EVENT_REVISION}`,
        );
    });
});

describe("publishAffectedAreaArtifacts", () => {
    it("puts canonical source, tiles, then manifest last with metadata", async () => {
        const bucket = new FakeAffectedAreaR2Bucket();
        const result = await publishAffectedAreaArtifacts({
            bucket,
            artifacts: makeArtifacts(),
            eventRevision: EVENT_REVISION,
        });

        expect(result.objectKeys).toStrictEqual(bucket.puts.map((put) => put.key));
        expect(bucket.puts.map((put) => put.key)).toStrictEqual([
            `affected-area/events/${EVENT_UID}/revisions/${EVENT_REVISION}/affected-cells.json`,
            `affected-area/events/${EVENT_UID}/revisions/${EVENT_REVISION}/raster/6/56/24.svg`,
            `affected-area/events/${EVENT_UID}/revisions/${EVENT_REVISION}/raster/7/113/49.svg`,
            `affected-area/events/${EVENT_UID}/revisions/${EVENT_REVISION}/cells/11/1832/808.json`,
            `affected-area/events/${EVENT_UID}/revisions/${EVENT_REVISION}/affected-area-manifest.json`,
        ]);

        const manifestPut = bucket.puts.at(-1);
        expect(manifestPut?.key).toBe(affectedAreaManifestR2Key(EVENT_UID, EVENT_REVISION));
        expect(manifestPut?.options?.httpMetadata?.contentType).toBe("application/json");
        expect(manifestPut?.options?.httpMetadata?.cacheControl).toBe(
            AFFECTED_AREA_ARTIFACT_CACHE_CONTROL,
        );

        const rasterPut = bucket.puts.find((put) => put.key.endsWith(".svg"));
        expect(rasterPut?.options?.httpMetadata?.contentType).toBe("image/svg+xml");

        for (const put of bucket.puts) {
            expect(put.options?.httpMetadata?.cacheControl).toBe(
                AFFECTED_AREA_ARTIFACT_CACHE_CONTROL,
            );
        }
    });

    it("does not put the manifest when an earlier artifact put fails", async () => {
        const manifestKey = affectedAreaManifestR2Key(EVENT_UID, EVENT_REVISION);
        const failKey = `affected-area/events/${EVENT_UID}/revisions/${EVENT_REVISION}/raster/6/56/24.svg`;
        const bucket = new FakeAffectedAreaR2Bucket(failKey);

        await expect(
            publishAffectedAreaArtifacts({
                bucket,
                artifacts: makeArtifacts(),
                eventRevision: EVENT_REVISION,
            }),
        ).rejects.toThrow(/put failed/u);

        expect(bucket.puts.map((put) => put.key)).not.toContain(manifestKey);
    });

    it("uses the same object keys and bytes on retry", async () => {
        const artifacts = makeArtifacts();
        const firstBucket = new FakeAffectedAreaR2Bucket();
        const secondBucket = new FakeAffectedAreaR2Bucket();

        await publishAffectedAreaArtifacts({
            bucket: firstBucket,
            artifacts,
            eventRevision: EVENT_REVISION,
        });
        await publishAffectedAreaArtifacts({
            bucket: secondBucket,
            artifacts,
            eventRevision: EVENT_REVISION,
        });

        expect(firstBucket.puts.map(({ key, value }) => ({ key, value }))).toStrictEqual(
            secondBucket.puts.map(({ key, value }) => ({ key, value })),
        );
    });
});
