import { describe, expect, it, vi } from "vitest";
import {
    classifyResidenceCell,
    ResidenceClassifierError,
} from "./h3-cell-classifier";

const CELL_DECIMAL = "613177652812406783";
const WORKER_URL = "https://residence-worker.example";

describe("classifyResidenceCell", () => {
    it("1. 200 のとき land を返す", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ proof: "dummy" }), { status: 200 }),
        );

        const result = await classifyResidenceCell({
            cellDecimal: CELL_DECIMAL,
            workerUrl: WORKER_URL,
            fetchImpl,
        });

        expect(result.cellDecimal).toBe(CELL_DECIMAL);
        expect(result.classification).toBe("land");
    });

    it("2. 404 + residence_cell_not_allowed のとき water を返す（reason 付き）", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    error: {
                        code: "residence_cell_not_allowed",
                        message: "Residence cell is not in the allowlist",
                    },
                }),
                { status: 404 },
            ),
        );

        const result = await classifyResidenceCell({
            cellDecimal: CELL_DECIMAL,
            workerUrl: WORKER_URL,
            fetchImpl,
        });

        expect(result.cellDecimal).toBe(CELL_DECIMAL);
        expect(result.classification).toBe("water");
        expect(result.reason).toBeTruthy();
    });

    it("3. 400 のとき ResidenceClassifierError (invalid_h3_index) を throw する", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    error: {
                        code: "invalid_h3_index",
                        message: "h3_index is invalid",
                    },
                }),
                { status: 400 },
            ),
        );

        await expect(
            classifyResidenceCell({
                cellDecimal: CELL_DECIMAL,
                workerUrl: WORKER_URL,
                fetchImpl,
            }),
        ).rejects.toMatchObject({ code: "invalid_h3_index" });

        await expect(
            classifyResidenceCell({
                cellDecimal: CELL_DECIMAL,
                workerUrl: WORKER_URL,
                fetchImpl,
            }),
        ).rejects.toBeInstanceOf(ResidenceClassifierError);
    });

    it("4. workerUrl が空文字のとき unknown を返し fetch を呼ばない", async () => {
        const fetchImpl = vi.fn();

        const result = await classifyResidenceCell({
            cellDecimal: CELL_DECIMAL,
            workerUrl: "",
            fetchImpl,
        });

        expect(result.classification).toBe("unknown");
        expect(result.reason).toBeTruthy();
        expect(fetchImpl).toHaveBeenCalledTimes(0);
    });

    it("5. fetch が reject（ネットワーク失敗）のとき unknown を返す（throw しない）", async () => {
        const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));

        const result = await classifyResidenceCell({
            cellDecimal: CELL_DECIMAL,
            workerUrl: WORKER_URL,
            fetchImpl,
        });

        expect(result.classification).toBe("unknown");
        expect(result.reason).toBeTruthy();
    });

    it("6. 5xx のとき unknown を返す", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({ error: { code: "proof_invalid", message: "Internal error" } }),
                { status: 500 },
            ),
        );

        const result = await classifyResidenceCell({
            cellDecimal: CELL_DECIMAL,
            workerUrl: WORKER_URL,
            fetchImpl,
        });

        expect(result.classification).toBe("unknown");
    });

    it("7. 末尾スラッシュ付き workerUrl で正しい URL（二重スラッシュ無し）を組み立てる", async () => {
        const requestedUrls: string[] = [];
        const fetchImpl = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
            requestedUrls.push(String(input));
            return new Response(JSON.stringify({}), { status: 200 });
        });

        await classifyResidenceCell({
            cellDecimal: CELL_DECIMAL,
            workerUrl: "https://residence-worker.example/",
            fetchImpl,
        });

        expect(requestedUrls).toHaveLength(1);
        expect(requestedUrls[0]).toBe(
            `https://residence-worker.example/api/residence-proof?h3_index=${encodeURIComponent(CELL_DECIMAL)}`,
        );
        expect(requestedUrls[0]).not.toContain("//api");
    });

    it("8. 送信 URL に h3_index=<10進> のみが含まれ、緯度経度らしき文字列を含まない", async () => {
        const requestedUrls: string[] = [];
        const fetchImpl = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
            requestedUrls.push(String(input));
            return new Response(JSON.stringify({}), { status: 200 });
        });

        await classifyResidenceCell({
            cellDecimal: CELL_DECIMAL,
            workerUrl: WORKER_URL,
            fetchImpl,
        });

        const url = requestedUrls[0] ?? "";
        expect(url).toContain(`h3_index=${encodeURIComponent(CELL_DECIMAL)}`);
        // lat/lng/latitude/longitude のようなパラメータが含まれていないことを確認
        expect(url).not.toMatch(/lat(itude)?=/i);
        expect(url).not.toMatch(/l(ng|on)(gitude)?=/i);
    });

    it("9. 非数字 cellDecimal のとき invalid_h3_index を throw する", async () => {
        const fetchImpl = vi.fn();

        await expect(
            classifyResidenceCell({
                cellDecimal: "not-a-number",
                workerUrl: WORKER_URL,
                fetchImpl,
            }),
        ).rejects.toMatchObject({ code: "invalid_h3_index" });

        await expect(
            classifyResidenceCell({
                cellDecimal: "",
                workerUrl: WORKER_URL,
                fetchImpl,
            }),
        ).rejects.toMatchObject({ code: "invalid_h3_index" });
    });
});

describe("ResidenceClassifierError", () => {
    it("Error のサブクラスで code を持つ", () => {
        const error = new ResidenceClassifierError("invalid_h3_index", "bad cell");

        expect(error).toBeInstanceOf(Error);
        expect(error.code).toBe("invalid_h3_index");
        expect(error.message).toBe("bad cell");
    });
});
