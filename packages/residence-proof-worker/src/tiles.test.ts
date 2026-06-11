import { describe, expect, it } from "vitest";
import worker, { type Env, tileManifestObjectKey, tileObjectKey } from "./index.js";

const MERKLE_ROOT = `0x${"ab".repeat(32)}`;
const PARENT_HEX = "842f5abffffffff";
const PARENT_DEC = "595308219849506815";
const CELLS = ["608819013513904127", "608819013597790207", "608819013681676287"];

const fixtureConfig = { allowlistVersion: 1, geoResolution: 7 };

function validTile(): Record<string, unknown> {
    return {
        schema: "sonari.residence.tile.v1",
        schema_version: 1,
        allowlist_version: 1,
        geo_resolution: 7,
        tile_parent_resolution: 4,
        merkle_root: MERKLE_ROOT,
        parent_h3_index: PARENT_DEC,
        cells: CELLS,
    };
}

function validManifest(): Record<string, unknown> {
    return {
        schema: "sonari.residence.tile_manifest.v1",
        schema_version: 1,
        allowlist_version: 1,
        geo_resolution: 7,
        tile_parent_resolution: 4,
        merkle_root: MERKLE_ROOT,
        object_key_rule:
            "residence-cells/v{allowlist_version}/res{geo_resolution}/tiles/res4/{parent_hex}.json",
        tile_count: 1,
        total_cell_count: 3,
        tiles: [
            {
                parent_h3_index: PARENT_DEC,
                object_key: tileObjectKey(1, 7, PARENT_HEX),
                cell_count: 3,
                sha256: `0x${"cd".repeat(32)}`,
                byte_size: 256,
            },
        ],
    };
}

describe("residence tile Worker API", () => {
    it("serves tile meta with a short cache lifetime", async () => {
        const env = buildEnv();
        const response = await worker.fetch(
            new Request("https://worker.example/api/residence-tiles/meta"),
            env,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("public, max-age=300");
        expect(response.headers.get("access-control-allow-origin")).toBe("*");
        await expect(response.json()).resolves.toMatchObject({
            allowlist_version: 1,
            geo_resolution: 7,
            tile_parent_resolution: 4,
            merkle_root: MERKLE_ROOT,
            tile_count: 1,
            total_cell_count: 3,
        });
        // meta must not ship the full inventory.
        expect(await (await worker.fetch(metaRequest(), env)).json()).not.toHaveProperty("tiles");
    });

    it("serves a tile with an immutable cache lifetime", async () => {
        const env = buildEnv();
        const response = await worker.fetch(tileRequest(PARENT_HEX), env);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        await expect(response.json()).resolves.toMatchObject({
            parent_h3_index: PARENT_DEC,
            cells: CELLS,
        });
    });

    it("returns 404 tile_not_found when the parent has no allowed cells", async () => {
        const env = buildEnv();
        await expectErrorCode(
            await worker.fetch(tileRequest("8428c2fffffffff"), env),
            404,
            "tile_not_found",
        );
    });

    it("fails closed when the path version does not match Worker config", async () => {
        const env = buildEnv();
        await expectErrorCode(
            await worker.fetch(
                new Request(
                    `https://worker.example/api/residence-tiles/v2/res7/${PARENT_HEX}.json`,
                ),
                env,
            ),
            409,
            "tile_version_mismatch",
        );
        await expectErrorCode(
            await worker.fetch(
                new Request(
                    `https://worker.example/api/residence-tiles/v1/res9/${PARENT_HEX}.json`,
                ),
                env,
            ),
            409,
            "tile_version_mismatch",
        );
    });

    it("returns 500 tile_invalid for a malformed tile object", async () => {
        const env = buildEnv({ tile: { ...validTile(), schema: "wrong" } });
        await expectErrorCode(
            await worker.fetch(tileRequest(PARENT_HEX), env),
            500,
            "tile_invalid",
        );
    });

    it("returns 500 tile_invalid when the tile parent does not match the path", async () => {
        const env = buildEnv({ tile: { ...validTile(), parent_h3_index: "595272305676779519" } });
        await expectErrorCode(
            await worker.fetch(tileRequest(PARENT_HEX), env),
            500,
            "tile_invalid",
        );
    });

    it("returns 500 tile_manifest_missing when meta manifest is absent", async () => {
        const env = buildEnv({ includeManifest: false });
        await expectErrorCode(await worker.fetch(metaRequest(), env), 500, "tile_manifest_missing");
    });

    it("answers OPTIONS preflight and rejects non-GET", async () => {
        const env = buildEnv();
        const preflight = await worker.fetch(
            new Request(`https://worker.example/api/residence-tiles/v1/res7/${PARENT_HEX}.json`, {
                method: "OPTIONS",
            }),
            env,
        );
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get("access-control-allow-origin")).toBe("*");

        await expectErrorCode(
            await worker.fetch(
                new Request(
                    `https://worker.example/api/residence-tiles/v1/res7/${PARENT_HEX}.json`,
                    { method: "POST" },
                ),
                env,
            ),
            405,
            "method_not_allowed",
        );
    });
});

function metaRequest(): Request {
    return new Request("https://worker.example/api/residence-tiles/meta");
}

function tileRequest(parentHex: string): Request {
    return new Request(`https://worker.example/api/residence-tiles/v1/res7/${parentHex}.json`);
}

function buildEnv(
    options: { tile?: unknown; includeManifest?: boolean; includeTile?: boolean } = {},
): Env & { RESIDENCE_PROOF_SHARDS: FakeR2Bucket } {
    const entries: Array<[string, Uint8Array]> = [];
    if (options.includeManifest !== false) {
        entries.push([
            tileManifestObjectKey(fixtureConfig),
            textBytes(JSON.stringify(validManifest())),
        ]);
    }
    if (options.includeTile !== false) {
        entries.push([
            tileObjectKey(1, 7, PARENT_HEX),
            textBytes(JSON.stringify(options.tile ?? validTile())),
        ]);
    }
    return {
        RESIDENCE_PROOF_SHARDS: new FakeR2Bucket(entries),
        ALLOWLIST_VERSION: "1",
        GEO_RESOLUTION: "7",
    };
}

async function expectErrorCode(response: Response, status: number, code: string): Promise<void> {
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({
        error: {
            code,
            message: expect.any(String),
        },
    });
}

function textBytes(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

class FakeR2Bucket {
    private readonly objects = new Map<string, Uint8Array>();

    constructor(entries: Array<[string, Uint8Array]>) {
        for (const [key, value] of entries) {
            this.objects.set(key, value);
        }
    }

    async get(key: string): Promise<FakeR2Object | null> {
        const value = this.objects.get(key);
        return value === undefined ? null : new FakeR2Object(value);
    }
}

class FakeR2Object {
    constructor(private readonly bytes: Uint8Array) {}

    async arrayBuffer(): Promise<ArrayBuffer> {
        const buffer = new ArrayBuffer(this.bytes.byteLength);
        new Uint8Array(buffer).set(this.bytes);
        return buffer;
    }
}
