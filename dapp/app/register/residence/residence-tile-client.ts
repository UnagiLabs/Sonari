import { parseResidenceTile, RESIDENCE_TILE_PARENT_RESOLUTION } from "@sonari/proof-core";
import { cellToParent } from "h3-js";
import type { ResidenceCellClass } from "./h3-cell-classifier";
import { h3DecimalToHex } from "./h3-geo";

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

export interface ResidenceTileClientOptions {
    /** Worker のベース URL。空文字なら一切 fetch せず unknown を返す。 */
    readonly workerUrl: string;
    /** テスト差し替え用。未指定なら globalThis.fetch を使う。 */
    readonly fetchImpl?: typeof fetch;
}

export interface ResidenceTileClient {
    /** 1 セル（10進 u64 文字列）を land/water/unknown へ分類する。 */
    classifyCell(cellDecimal: string): Promise<ResidenceCellClass>;
    /** 複数セルをまとめて分類する。同一親のセルは tile を共有する。 */
    classifyCells(cellDecimals: readonly string[]): Promise<Map<string, ResidenceCellClass>>;
}

interface TileMeta {
    readonly allowlistVersion: number;
    readonly geoResolution: number;
    readonly merkleRoot: string;
}

/**
 * 親 tile 1 件の判定結果。
 * - tile: 200。`cells` への所属で land/water を決める。
 * - all-water: 404。許可セル 0 個の親なので全て water。
 * - unknown: network/invalid/version 不一致/meta 未取得。表示を保留する。
 */
type TileResult =
    | { readonly kind: "tile"; readonly cells: ReadonlySet<string> }
    | { readonly kind: "all-water" }
    | { readonly kind: "unknown" };

const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/u;

// ---------------------------------------------------------------------------
// ファクトリ
// ---------------------------------------------------------------------------

export function createResidenceTileClient(
    options: ResidenceTileClientOptions,
): ResidenceTileClient {
    const base = options.workerUrl.trim().replace(/\/+$/u, "");
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;

    // meta は version を確定するため 1 回だけ取得し、成功時のみ保持する。
    // 失敗時は null に戻して次回リトライできるようにする。
    let metaPromise: Promise<TileMeta> | null = null;
    // 親 hex -> tile 判定。成功(tile/all-water)のみ保持し、unknown はキャッシュしない。
    const tileCache = new Map<string, Promise<TileResult>>();

    function getMeta(): Promise<TileMeta> {
        if (metaPromise === null) {
            metaPromise = fetchMeta(fetchImpl, base).catch((error: unknown) => {
                metaPromise = null;
                throw error;
            });
        }
        return metaPromise;
    }

    function getTile(parentHex: string): Promise<TileResult> {
        const cached = tileCache.get(parentHex);
        if (cached !== undefined) {
            return cached;
        }
        const promise = resolveTile(fetchImpl, base, getMeta, parentHex).then((result) => {
            // unknown は一時的な不調の可能性があるためキャッシュせず再取得を許す。
            if (result.kind === "unknown") {
                tileCache.delete(parentHex);
            }
            return result;
        });
        tileCache.set(parentHex, promise);
        return promise;
    }

    async function classifyCell(cellDecimal: string): Promise<ResidenceCellClass> {
        if (base.length === 0 || !DECIMAL_PATTERN.test(cellDecimal)) {
            return "unknown";
        }
        let parentHex: string;
        try {
            const hex = h3DecimalToHex(cellDecimal);
            parentHex = cellToParent(hex, RESIDENCE_TILE_PARENT_RESOLUTION);
        } catch {
            return "unknown";
        }

        const result = await getTile(parentHex);
        if (result.kind === "all-water") {
            return "water";
        }
        if (result.kind === "unknown") {
            return "unknown";
        }
        return result.cells.has(cellDecimal) ? "land" : "water";
    }

    async function classifyCells(
        cellDecimals: readonly string[],
    ): Promise<Map<string, ResidenceCellClass>> {
        const out = new Map<string, ResidenceCellClass>();
        const unique = [...new Set(cellDecimals)];
        await Promise.all(
            unique.map(async (decimal) => {
                out.set(decimal, await classifyCell(decimal));
            }),
        );
        return out;
    }

    return { classifyCell, classifyCells };
}

// ---------------------------------------------------------------------------
// fetch ヘルパー
// ---------------------------------------------------------------------------

async function fetchMeta(fetchImpl: typeof fetch, base: string): Promise<TileMeta> {
    const response = await fetchImpl(`${base}/api/residence-tiles/meta`, { method: "GET" });
    if (response.status !== 200) {
        throw new Error(`residence tile meta returned HTTP ${response.status}`);
    }
    return parseMeta(await response.json());
}

async function resolveTile(
    fetchImpl: typeof fetch,
    base: string,
    getMeta: () => Promise<TileMeta>,
    parentHex: string,
): Promise<TileResult> {
    let meta: TileMeta;
    try {
        meta = await getMeta();
    } catch {
        return { kind: "unknown" };
    }

    const url = `${base}/api/residence-tiles/v${meta.allowlistVersion}/res${meta.geoResolution}/${parentHex}.json`;
    let response: Response;
    try {
        response = await fetchImpl(url, { method: "GET" });
    } catch {
        return { kind: "unknown" };
    }

    if (response.status === 404) {
        return { kind: "all-water" };
    }
    if (response.status !== 200) {
        return { kind: "unknown" };
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        return { kind: "unknown" };
    }

    try {
        const tile = parseResidenceTile(body, {
            allowlistVersion: meta.allowlistVersion,
            geoResolution: meta.geoResolution,
            merkleRoot: meta.merkleRoot,
        });
        // path の親と tile 本体の親（十進）が一致することを確認する。
        if (tile.parent_h3_index !== BigInt(`0x${parentHex}`).toString()) {
            return { kind: "unknown" };
        }
        return { kind: "tile", cells: new Set(tile.cells) };
    } catch {
        return { kind: "unknown" };
    }
}

// ---------------------------------------------------------------------------
// meta パーサ（meta endpoint は inventory を含まないため軽量に読む）
// ---------------------------------------------------------------------------

function parseMeta(value: unknown): TileMeta {
    if (typeof value !== "object" || value === null) {
        throw new Error("residence tile meta must be an object");
    }
    const record = value as Record<string, unknown>;
    const allowlistVersion = expectPositiveInteger(record.allowlist_version, "allowlist_version");
    const geoResolution = expectPositiveInteger(record.geo_resolution, "geo_resolution");
    const merkleRoot = record.merkle_root;
    if (typeof merkleRoot !== "string" || !/^0x[0-9a-f]{64}$/u.test(merkleRoot)) {
        throw new Error("residence tile meta merkle_root must be a 0x-prefixed 32-byte hex");
    }
    return { allowlistVersion, geoResolution, merkleRoot };
}

function expectPositiveInteger(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`residence tile meta ${field} must be a positive integer`);
    }
    return value;
}
