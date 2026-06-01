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
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/api/residence-proof") {
        return jsonResponse({ error: { code: "not_found", message: "Not found" } }, 404);
    }

    const config = readConfig(env);
    const h3IndexParam = url.searchParams.get("h3_index");
    if (h3IndexParam === null) {
        return jsonResponse(
            { error: { code: "invalid_h3_index", message: "h3_index is required" } },
            400,
        );
    }

    const h3Index = parseH3Index(h3IndexParam, config.geoResolution);
    const manifest = await loadProofManifest(env.RESIDENCE_PROOF_SHARDS, config);
    const shardId = await proofShardId(h3Index.value, manifest.shard_count);
    const inventory = manifest.shards[shardId];
    if (inventory === undefined) {
        return jsonResponse(
            {
                error: {
                    code: "proof_manifest_invalid",
                    message: "Proof shard inventory is missing",
                },
            },
            500,
        );
    }

    const shard = await loadProofShard(env.RESIDENCE_PROOF_SHARDS, inventory, manifest);
    const entry = findProofEntry(shard, h3Index);
    if (entry === null) {
        return jsonResponse(
            {
                error: {
                    code: "residence_cell_not_allowed",
                    message: "Residence cell is not in the allowlist",
                },
            },
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
        throw new Error(`${name} must be a non-negative integer`);
    }
    return parsed;
}
