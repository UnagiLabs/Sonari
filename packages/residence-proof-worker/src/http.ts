import { errorResponse, ResidenceProofError, toResidenceProofError } from "./errors.js";
import {
    findProofEntry,
    parseH3Index,
    proofShardId,
    shapeProofResponse,
    validateProofEntry,
} from "./proof_shards.js";
import { loadProofManifest, loadProofShard } from "./r2.js";

export interface Env {
    RESIDENCE_PROOF_SHARDS: ResidenceProofR2Bucket;
    ALLOWLIST_VERSION: string | number;
    GEO_RESOLUTION: string | number;
}

export interface ResidenceProofR2Bucket {
    get(key: string): Promise<ResidenceProofR2Object | null>;
}

export interface ResidenceProofR2Object {
    arrayBuffer(): Promise<ArrayBuffer>;
}

export async function handleResidenceProofRequest(request: Request, env: Env): Promise<Response> {
    try {
        return await handleResidenceProofRequestUnchecked(request, env);
    } catch (error) {
        return errorResponse(toResidenceProofError(error));
    }
}

async function handleResidenceProofRequestUnchecked(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api/residence-proof") {
        throw new ResidenceProofError("not_found", "Not found", 404);
    }
    if (request.method !== "GET") {
        throw new ResidenceProofError("method_not_allowed", "Only GET is supported", 405);
    }
    const config = readConfig(env);
    const h3IndexParam = url.searchParams.get("h3_index");
    if (h3IndexParam === null) {
        throw new ResidenceProofError("invalid_h3_index", "h3_index is required", 400);
    }

    const h3Index = parseRequestH3Index(h3IndexParam, config.geoResolution);
    const manifest = await loadProofManifest(env.RESIDENCE_PROOF_SHARDS, config);
    const shardId = await proofShardId(h3Index.value, manifest.shard_count);
    const inventory = manifest.shards.find((entry) => entry.shard_id === shardId);
    if (inventory === undefined) {
        throw new ResidenceProofError(
            "proof_manifest_invalid",
            "Proof shard inventory is missing",
            500,
        );
    }

    const shard = await loadProofShard(env.RESIDENCE_PROOF_SHARDS, inventory, manifest);
    const entry = findProofEntry(shard, h3Index);
    if (entry === null) {
        throw new ResidenceProofError(
            "residence_cell_not_allowed",
            "Residence cell is not in the allowlist",
            404,
        );
    }

    const validated = await validateProofEntry(entry, {
        allowlistVersion: manifest.allowlist_version,
        geoResolution: manifest.geo_resolution,
        merkleRoot: manifest.merkle_root,
        shardId,
        shardCount: manifest.shard_count,
    });
    return jsonResponse(
        shapeProofResponse(validated, {
            allowlistVersion: manifest.allowlist_version,
            geoResolution: manifest.geo_resolution,
        }),
        200,
    );
}

export function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
        },
    });
}

function readConfig(env: Env): { allowlistVersion: number; geoResolution: number } {
    return {
        allowlistVersion: parseConfigInteger("ALLOWLIST_VERSION", env.ALLOWLIST_VERSION),
        geoResolution: parseConfigInteger("GEO_RESOLUTION", env.GEO_RESOLUTION),
    };
}

function parseConfigInteger(name: string, value: string | number): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new ResidenceProofError(
            "proof_manifest_invalid",
            `${name} must be a non-negative integer`,
            500,
        );
    }
    return parsed;
}

function parseRequestH3Index(value: string, expectedResolution: number) {
    try {
        return parseH3Index(value, expectedResolution);
    } catch (error) {
        const message = error instanceof Error ? error.message : "h3_index is invalid";
        throw new ResidenceProofError("invalid_h3_index", message, 400);
    }
}
