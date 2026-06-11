import { describe, expect, it, vi } from "vitest";
import { createResidenceTileClient } from "./residence-tile-client";

const WORKER_URL = "https://residence-worker.example";
const MERKLE_ROOT = `0x${"ab".repeat(32)}`;

// h3-js で検証済みの res4 親 ↔ res7 子の対応（dapp/node で確認した実データ）。
const PARENT_A_HEX = "842f5abffffffff";
const PARENT_A_DEC = "595308219849506815";
const A_CELLS = ["608819010158460927", "608819010175238143", "608819010192015359"];
// 親 A に属するが allowlist には無い res7 セル（200 tile + membership miss = water）。
const A_WATER_CELL = "608819010208792575";

const PARENT_B_HEX = "842f5a3ffffffff";
const PARENT_B_DEC = "595308185489768447";
const B_CELLS = ["608818975798722559", "608818975815499775", "608818975832276991"];

function metaBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        schema: "sonari.residence.tile_manifest.v1",
        schema_version: 1,
        allowlist_version: 1,
        geo_resolution: 7,
        tile_parent_resolution: 4,
        merkle_root: MERKLE_ROOT,
        object_key_rule:
            "residence-cells/v{allowlist_version}/res{geo_resolution}/tiles/res4/{parent_hex}.json",
        tile_count: 2,
        total_cell_count: 6,
        ...overrides,
    };
}

function tileBody(
    parentDec: string,
    cells: string[],
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        schema: "sonari.residence.tile.v1",
        schema_version: 1,
        allowlist_version: 1,
        geo_resolution: 7,
        tile_parent_resolution: 4,
        merkle_root: MERKLE_ROOT,
        parent_h3_index: parentDec,
        cells,
        ...overrides,
    };
}

interface FetchScript {
    meta?: () => Response;
    tiles?: Record<string, () => Response>;
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
}

/** URL からルーティングする fetch モック。呼び出し URL を記録する。 */
function makeFetch(script: FetchScript): {
    fetchImpl: typeof fetch;
    calls: string[];
} {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/api/residence-tiles/meta")) {
            if (script.meta === undefined) {
                return new Response("not found", { status: 404 });
            }
            return script.meta();
        }
        const match = /\/api\/residence-tiles\/v\d+\/res\d+\/([0-9a-f]+)\.json$/u.exec(url);
        if (match !== null) {
            const parentHex = match[1] ?? "";
            const handler = script.tiles?.[parentHex];
            if (handler === undefined) {
                return new Response(JSON.stringify({ error: { code: "tile_not_found" } }), {
                    status: 404,
                });
            }
            return handler();
        }
        return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
}

describe("createResidenceTileClient", () => {
    it("1. allowlist に含まれる res7 セルを land と判定する", async () => {
        const { fetchImpl, calls } = makeFetch({
            meta: () => jsonResponse(metaBody()),
            tiles: { [PARENT_A_HEX]: () => jsonResponse(tileBody(PARENT_A_DEC, A_CELLS)) },
        });
        const client = createResidenceTileClient({ workerUrl: WORKER_URL, fetchImpl });

        await expect(client.classifyCell(A_CELLS[0] ?? "")).resolves.toBe("land");
        // meta 1 回 + tile 1 回。
        expect(calls.filter((u) => u.endsWith("/meta"))).toHaveLength(1);
        expect(calls.filter((u) => u.includes(`/${PARENT_A_HEX}.json`))).toHaveLength(1);
    });

    it("2. 親 tile はあるが allowlist に無いセルを water と判定する", async () => {
        const { fetchImpl } = makeFetch({
            meta: () => jsonResponse(metaBody()),
            tiles: { [PARENT_A_HEX]: () => jsonResponse(tileBody(PARENT_A_DEC, A_CELLS)) },
        });
        const client = createResidenceTileClient({ workerUrl: WORKER_URL, fetchImpl });

        await expect(client.classifyCell(A_WATER_CELL)).resolves.toBe("water");
    });

    it("3. 親 tile が 404（許可セル 0 個）のセルを water と判定する", async () => {
        const { fetchImpl } = makeFetch({
            meta: () => jsonResponse(metaBody()),
            tiles: {}, // どの親も 404
        });
        const client = createResidenceTileClient({ workerUrl: WORKER_URL, fetchImpl });

        await expect(client.classifyCell(A_CELLS[0] ?? "")).resolves.toBe("water");
    });

    it("4. 複数 tile にまたがる viewport を 1 tile/親 で分類する", async () => {
        const { fetchImpl, calls } = makeFetch({
            meta: () => jsonResponse(metaBody()),
            tiles: {
                [PARENT_A_HEX]: () => jsonResponse(tileBody(PARENT_A_DEC, A_CELLS)),
                [PARENT_B_HEX]: () => jsonResponse(tileBody(PARENT_B_DEC, B_CELLS)),
            },
        });
        const client = createResidenceTileClient({ workerUrl: WORKER_URL, fetchImpl });

        const result = await client.classifyCells([...A_CELLS, ...B_CELLS, A_WATER_CELL]);

        for (const cell of [...A_CELLS, ...B_CELLS]) {
            expect(result.get(cell)).toBe("land");
        }
        expect(result.get(A_WATER_CELL)).toBe("water");
        // 親 A・B それぞれ 1 回ずつ（同一親のセルは tile を共有する）。
        expect(calls.filter((u) => u.includes(`/${PARENT_A_HEX}.json`))).toHaveLength(1);
        expect(calls.filter((u) => u.includes(`/${PARENT_B_HEX}.json`))).toHaveLength(1);
        expect(calls.filter((u) => u.endsWith("/meta"))).toHaveLength(1);
    });

    it("5. tile 応答が壊れているとき unknown を返す", async () => {
        const { fetchImpl } = makeFetch({
            meta: () => jsonResponse(metaBody()),
            tiles: {
                [PARENT_A_HEX]: () =>
                    jsonResponse(tileBody(PARENT_A_DEC, A_CELLS, { schema: "wrong" })),
            },
        });
        const client = createResidenceTileClient({ workerUrl: WORKER_URL, fetchImpl });

        await expect(client.classifyCell(A_CELLS[0] ?? "")).resolves.toBe("unknown");
    });

    it("6. tile の allowlist_version が meta と食い違うとき unknown を返す", async () => {
        const { fetchImpl } = makeFetch({
            meta: () => jsonResponse(metaBody()),
            tiles: {
                [PARENT_A_HEX]: () =>
                    jsonResponse(tileBody(PARENT_A_DEC, A_CELLS, { allowlist_version: 2 })),
            },
        });
        const client = createResidenceTileClient({ workerUrl: WORKER_URL, fetchImpl });

        await expect(client.classifyCell(A_CELLS[0] ?? "")).resolves.toBe("unknown");
    });

    it("7. meta を取得できないとき全て unknown を返し tile を取りに行かない", async () => {
        const { fetchImpl, calls } = makeFetch({
            meta: () => new Response("nope", { status: 503 }),
            tiles: { [PARENT_A_HEX]: () => jsonResponse(tileBody(PARENT_A_DEC, A_CELLS)) },
        });
        const client = createResidenceTileClient({ workerUrl: WORKER_URL, fetchImpl });

        await expect(client.classifyCell(A_CELLS[0] ?? "")).resolves.toBe("unknown");
        expect(calls.filter((u) => u.includes(`/${PARENT_A_HEX}.json`))).toHaveLength(0);
    });

    it("8. tile はキャッシュされ同一親を再取得しない", async () => {
        const { fetchImpl, calls } = makeFetch({
            meta: () => jsonResponse(metaBody()),
            tiles: { [PARENT_A_HEX]: () => jsonResponse(tileBody(PARENT_A_DEC, A_CELLS)) },
        });
        const client = createResidenceTileClient({ workerUrl: WORKER_URL, fetchImpl });

        await client.classifyCell(A_CELLS[0] ?? "");
        await client.classifyCell(A_CELLS[1] ?? "");
        await client.classifyCell(A_WATER_CELL);

        expect(calls.filter((u) => u.includes(`/${PARENT_A_HEX}.json`))).toHaveLength(1);
        expect(calls.filter((u) => u.endsWith("/meta"))).toHaveLength(1);
    });

    it("9. network 失敗（fetch reject）のとき unknown を返す", async () => {
        const fetchImpl = vi.fn().mockRejectedValue(new Error("network down")) as unknown as
            typeof fetch;
        const client = createResidenceTileClient({ workerUrl: WORKER_URL, fetchImpl });

        await expect(client.classifyCell(A_CELLS[0] ?? "")).resolves.toBe("unknown");
    });

    it("10. workerUrl が空のとき unknown を返し fetch を呼ばない", async () => {
        const fetchImpl = vi.fn() as unknown as typeof fetch;
        const client = createResidenceTileClient({ workerUrl: "", fetchImpl });

        await expect(client.classifyCell(A_CELLS[0] ?? "")).resolves.toBe("unknown");
        expect(fetchImpl).toHaveBeenCalledTimes(0);
    });

    it("11. 末尾スラッシュ付き workerUrl で二重スラッシュ無しの URL を組み立てる", async () => {
        const { fetchImpl, calls } = makeFetch({
            meta: () => jsonResponse(metaBody()),
            tiles: { [PARENT_A_HEX]: () => jsonResponse(tileBody(PARENT_A_DEC, A_CELLS)) },
        });
        const client = createResidenceTileClient({
            workerUrl: "https://residence-worker.example/",
            fetchImpl,
        });

        await client.classifyCell(A_CELLS[0] ?? "");

        for (const url of calls) {
            expect(url).not.toMatch(/[^:]\/\//u);
        }
        expect(calls.some((u) => u.endsWith("/api/residence-tiles/meta"))).toBe(true);
    });

    it("12. 非数字 cellDecimal のとき unknown を返す（throw しない）", async () => {
        const { fetchImpl } = makeFetch({ meta: () => jsonResponse(metaBody()) });
        const client = createResidenceTileClient({ workerUrl: WORKER_URL, fetchImpl });

        await expect(client.classifyCell("not-a-number")).resolves.toBe("unknown");
        await expect(client.classifyCell("")).resolves.toBe("unknown");
    });
});
