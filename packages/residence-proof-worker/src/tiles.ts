import { parseResidenceTile } from "@sonari/proof-core";
import { CORS_HEADERS, ResidenceProofError } from "./errors.js";
import type { Env } from "./http.js";
import { loadTileBytes, loadTileManifest, tileObjectKey } from "./r2.js";

const TILE_META_PATH = "/api/residence-tiles/meta";
const TILE_PATH_PATTERN = /^\/api\/residence-tiles\/v(\d+)\/res(\d+)\/([0-9a-f]+)\.json$/;

// meta は version を学ぶだけの軽い応答。短い max-age で stale を防ぎつつ edge cache に乗せる。
const META_CACHE_CONTROL = "public, max-age=300";
// tile 本体は version 入りの immutable URL。長期 cache でブラウザと edge cache に固定する。
const TILE_CACHE_CONTROL = "public, max-age=31536000, immutable";

export interface TileExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
}

interface EdgeCache {
    match(request: Request): Promise<Response | undefined>;
    put(request: Request, response: Response): Promise<void>;
}

interface ParsedTilePath {
    allowlistVersion: number;
    geoResolution: number;
    parentHex: string;
}

export function isResidenceTilePath(pathname: string): boolean {
    return pathname === TILE_META_PATH || TILE_PATH_PATTERN.test(pathname);
}

export async function handleResidenceTileRequest(
    request: Request,
    env: Env,
    config: { allowlistVersion: number; geoResolution: number },
    ctx?: TileExecutionContext,
): Promise<Response> {
    if (request.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: { ...CORS_HEADERS, "access-control-max-age": "86400" },
        });
    }
    if (request.method !== "GET") {
        throw new ResidenceProofError("method_not_allowed", "Only GET is supported", 405);
    }

    const url = new URL(request.url);
    if (url.pathname === TILE_META_PATH) {
        return handleTileMeta(env, config);
    }

    const parsed = parseTilePath(url.pathname);
    if (parsed === null) {
        throw new ResidenceProofError("not_found", "Not found", 404);
    }
    return handleTile(request, env, config, parsed, ctx);
}

async function handleTileMeta(
    env: Env,
    config: { allowlistVersion: number; geoResolution: number },
): Promise<Response> {
    const manifest = await loadTileManifest(env.RESIDENCE_PROOF_SHARDS, config);
    return tileJsonResponse(
        {
            schema: manifest.schema,
            schema_version: manifest.schema_version,
            allowlist_version: manifest.allowlist_version,
            geo_resolution: manifest.geo_resolution,
            tile_parent_resolution: manifest.tile_parent_resolution,
            merkle_root: manifest.merkle_root,
            object_key_rule: manifest.object_key_rule,
            tile_count: manifest.tile_count,
            total_cell_count: manifest.total_cell_count,
        },
        200,
        META_CACHE_CONTROL,
    );
}

async function handleTile(
    request: Request,
    env: Env,
    config: { allowlistVersion: number; geoResolution: number },
    parsed: ParsedTilePath,
    ctx?: TileExecutionContext,
): Promise<Response> {
    // path version が Worker 設定と食い違う tile は fail-closed で拒否する。
    if (
        parsed.allowlistVersion !== config.allowlistVersion ||
        parsed.geoResolution !== config.geoResolution
    ) {
        throw new ResidenceProofError(
            "tile_version_mismatch",
            `Tile version v${parsed.allowlistVersion}/res${parsed.geoResolution} does not match Worker config v${config.allowlistVersion}/res${config.geoResolution}`,
            409,
        );
    }

    const cache = edgeCache();
    if (cache !== undefined) {
        const hit = await cache.match(request);
        if (hit !== undefined) {
            return hit;
        }
    }

    const key = tileObjectKey(config.allowlistVersion, config.geoResolution, parsed.parentHex);
    const bytes = await loadTileBytes(env.RESIDENCE_PROOF_SHARDS, key);
    if (bytes === null) {
        // tile が無い親 = 許可セルが 0 個。dapp はこれを「all water」と読む。
        throw new ResidenceProofError(
            "tile_not_found",
            `Tile is not in the allowlist: ${key}`,
            404,
        );
    }

    const tile = parseTileBytes(bytes, config, parsed);
    const response = tileJsonResponse(tile, 200, TILE_CACHE_CONTROL);

    if (cache !== undefined && ctx !== undefined) {
        ctx.waitUntil(cache.put(request, response.clone()));
    }
    return response;
}

function parseTileBytes(
    bytes: Uint8Array,
    config: { allowlistVersion: number; geoResolution: number },
    parsed: ParsedTilePath,
): unknown {
    let value: unknown;
    try {
        value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new ResidenceProofError("tile_invalid", "Tile JSON is invalid", 500);
    }

    let tile: ReturnType<typeof parseResidenceTile>;
    try {
        tile = parseResidenceTile(value, {
            allowlistVersion: config.allowlistVersion,
            geoResolution: config.geoResolution,
        });
    } catch {
        throw new ResidenceProofError("tile_invalid", "Tile is invalid", 500);
    }

    // path の parent_hex と tile 本体の parent_h3_index（十進）が一致することを確認する。
    const expectedParent = BigInt(`0x${parsed.parentHex}`).toString();
    if (tile.parent_h3_index !== expectedParent) {
        throw new ResidenceProofError(
            "tile_invalid",
            `Tile parent_h3_index ${tile.parent_h3_index} does not match requested ${expectedParent}`,
            500,
        );
    }
    return tile;
}

function parseTilePath(pathname: string): ParsedTilePath | null {
    const match = TILE_PATH_PATTERN.exec(pathname);
    if (match === null) {
        return null;
    }
    const allowlistVersion = Number(match[1]);
    const geoResolution = Number(match[2]);
    const parentHex = match[3] ?? "";
    if (!Number.isSafeInteger(allowlistVersion) || !Number.isSafeInteger(geoResolution)) {
        return null;
    }
    return { allowlistVersion, geoResolution, parentHex };
}

function tileJsonResponse(body: unknown, status: number, cacheControl: string): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": cacheControl,
            ...CORS_HEADERS,
        },
    });
}

function edgeCache(): EdgeCache | undefined {
    const caches = (globalThis as { caches?: { default?: EdgeCache } }).caches;
    return caches?.default;
}
