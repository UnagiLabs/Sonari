import { describe, expect, it } from "vitest";
import worker, { type Env } from "./index.js";
import { sha256Hex } from "./proof_shards.js";
import { proofManifestObjectKey } from "./r2.js";

const LEAF_THREE = {
    h3_index: "608819013681676287",
    leaf_hash: "0x8f8a501ba455071229e715f5eccb4322190440fa2ecb6b72d123378648b60ec7",
    proof: [
        {
            sibling_on_left: true,
            sibling_hash: "0x312e3863ccf00e446423342e1acebdab8e7119ee19dae854904de693225c2678",
        },
    ],
} as const;

const MERKLE_ROOT = "0xa26a12dc49754fde5b90e6bff69d1bc8b51fb8a3de07aa9122a9a2958bb75020";
const EMPTY_SHA256 = "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("residence proof Worker API", () => {
    it("returns only the requested proof from an R2 proof shard and caches the manifest", async () => {
        const env = await buildEnvWithFixtureR2();
        const request = new Request(
            "https://worker.example/api/residence-proof?h3_index=608819013681676287",
        );

        const firstResponse = await worker.fetch(request, env);
        const secondResponse = await worker.fetch(request, env);

        expect(firstResponse.status).toBe(200);
        expect(secondResponse.status).toBe(200);
        await expect(firstResponse.json()).resolves.toEqual({
            h3_index: LEAF_THREE.h3_index,
            allowlist_version: 1,
            geo_resolution: 7,
            merkle_root: MERKLE_ROOT,
            proof: LEAF_THREE.proof,
        });
        expect(await secondResponse.json()).not.toHaveProperty("proofs");
        expect(env.RESIDENCE_PROOF_SHARDS.getCount(proofManifestObjectKey(fixtureConfig))).toBe(1);
        expect(
            env.RESIDENCE_PROOF_SHARDS.getCount(
                "residence-cells/v1/res7/proofs/shards/00000.json.gz",
            ),
        ).toBe(2);
    });

    it("returns stable errors for invalid requests", async () => {
        const env = await buildEnvWithFixtureR2();

        await expectErrorCode(
            await worker.fetch(new Request("https://worker.example/api/residence-proof"), env),
            400,
            "invalid_h3_index",
        );
        await expectErrorCode(
            await worker.fetch(
                new Request("https://worker.example/api/residence-proof?h3_index=not-decimal"),
                env,
            ),
            400,
            "invalid_h3_index",
        );
        await expectErrorCode(
            await worker.fetch(
                new Request(
                    "https://worker.example/api/residence-proof?h3_index=608819013513904127",
                ),
                env,
            ),
            404,
            "residence_cell_not_allowed",
        );
        await expectErrorCode(
            await worker.fetch(
                new Request(
                    "https://worker.example/api/residence-proof?h3_index=608819013681676287",
                    {
                        method: "POST",
                    },
                ),
                env,
            ),
            405,
            "method_not_allowed",
        );
        await expectErrorCode(
            await worker.fetch(new Request("https://worker.example/api/unknown"), env),
            404,
            "not_found",
        );
    });

    it("fails closed when R2 artifacts are missing or inconsistent", async () => {
        await expectErrorCode(
            await worker.fetch(
                new Request(
                    "https://worker.example/api/residence-proof?h3_index=608819013681676287",
                ),
                await buildEnvWithFixtureR2({ includeShard: false }),
            ),
            500,
            "proof_shard_missing",
        );
        await expectErrorCode(
            await worker.fetch(
                new Request(
                    "https://worker.example/api/residence-proof?h3_index=608819013681676287",
                ),
                await buildEnvWithFixtureR2({
                    manifestSha256: `0x${"ff".repeat(32)}`,
                }),
            ),
            500,
            "proof_shard_integrity_mismatch",
        );
        await expectErrorCode(
            await worker.fetch(
                new Request(
                    "https://worker.example/api/residence-proof?h3_index=608819013681676287",
                ),
                await buildEnvWithFixtureR2({
                    shardProofs: [
                        {
                            ...LEAF_THREE,
                            proof: [
                                {
                                    sibling_on_left: true,
                                    sibling_hash: `0x${"ff".repeat(32)}`,
                                },
                            ],
                        },
                    ],
                }),
            ),
            500,
            "proof_invalid",
        );
        await expectErrorCode(
            await worker.fetch(
                new Request(
                    "https://worker.example/api/residence-proof?h3_index=608819013681676287",
                ),
                await buildEnvWithFixtureR2({ manifestGeoResolution: 6 }),
            ),
            500,
            "proof_manifest_invalid",
        );
    });
});

const fixtureConfig = {
    allowlistVersion: 1,
    geoResolution: 7,
};

async function buildEnvWithFixtureR2(
    options: {
        includeShard?: boolean;
        manifestGeoResolution?: number;
        manifestSha256?: string;
        shardProofs?: unknown[];
    } = {},
): Promise<Env & { RESIDENCE_PROOF_SHARDS: FakeR2Bucket }> {
    const manifestGeoResolution = options.manifestGeoResolution ?? 7;
    const shardProofs = options.shardProofs ?? [LEAF_THREE];
    const shard = {
        schema: "sonari.residence.proof_shard.v1",
        schema_version: 1,
        allowlist_version: 1,
        geo_resolution: manifestGeoResolution,
        merkle_root: MERKLE_ROOT,
        shard_id: 0,
        shard_count: 5,
        proofs: shardProofs,
    };
    const shardBytes = await gzipJsonBytes(shard);
    const manifest = {
        schema: "sonari.residence.proof_manifest.v1",
        schema_version: 1,
        allowlist_version: 1,
        geo_resolution: manifestGeoResolution,
        merkle_root: MERKLE_ROOT,
        shard_count: 5,
        total_proof_count: shardProofs.length,
        object_key_rule:
            "residence-cells/v{allowlist_version}/res{geo_resolution}/proofs/shards/{shard_id:05}.json.gz",
        shards: [
            {
                shard_id: 0,
                object_key: proofShardObjectKey(0, manifestGeoResolution),
                proof_count: shardProofs.length,
                sha256: options.manifestSha256 ?? (await sha256Hex(shardBytes)),
                byte_size: shardBytes.byteLength,
            },
            emptyInventoryEntry(1, manifestGeoResolution),
            emptyInventoryEntry(2, manifestGeoResolution),
            emptyInventoryEntry(3, manifestGeoResolution),
            emptyInventoryEntry(4, manifestGeoResolution),
        ],
    };

    const entries: Array<[string, Uint8Array]> = [
        [proofManifestObjectKey(fixtureConfig), textBytes(JSON.stringify(manifest))],
    ];
    if (options.includeShard !== false) {
        entries.push([proofShardObjectKey(0, manifestGeoResolution), shardBytes]);
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

function emptyInventoryEntry(
    shardId: number,
    geoResolution: number,
): {
    shard_id: number;
    object_key: string;
    proof_count: 0;
    sha256: typeof EMPTY_SHA256;
    byte_size: 0;
} {
    return {
        shard_id: shardId,
        object_key: proofShardObjectKey(shardId, geoResolution),
        proof_count: 0,
        sha256: EMPTY_SHA256,
        byte_size: 0,
    };
}

function proofShardObjectKey(shardId: number, geoResolution: number): string {
    return `residence-cells/v1/res${geoResolution}/proofs/shards/${shardId
        .toString()
        .padStart(5, "0")}.json.gz`;
}

async function gzipJsonBytes(value: unknown): Promise<Uint8Array> {
    const stream = new Blob([JSON.stringify(value)]).stream();
    const compressed = stream.pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(compressed).arrayBuffer());
}

function textBytes(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

class FakeR2Bucket {
    private readonly objects = new Map<string, Uint8Array>();
    private readonly counts = new Map<string, number>();

    constructor(entries: Array<[string, Uint8Array]>) {
        for (const [key, value] of entries) {
            this.objects.set(key, value);
        }
    }

    async get(key: string): Promise<FakeR2Object | null> {
        this.counts.set(key, this.getCount(key) + 1);
        const value = this.objects.get(key);
        return value === undefined ? null : new FakeR2Object(value);
    }

    getCount(key: string): number {
        return this.counts.get(key) ?? 0;
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
