import { describe, expect, it } from "vitest";
import { AffectedCellsProofError } from "./errors.js";
import { type Env, fetchWalrusBlob } from "./walrus.js";

const AGGREGATOR_URL = "https://aggregator.walrus.example";
const BLOB_ID = "abc123def456";
const WALRUS_URI = `walrus://blob/${BLOB_ID}`;

function makeEnv(walrusAggregatorUrl: string = AGGREGATOR_URL): Env {
    return {
        WALRUS_AGGREGATOR_URL: walrusAggregatorUrl,
    };
}

function makeEnvEmpty(): Env {
    return {} as Env;
}

function makeFakeFetch(
    status: number,
    body: Uint8Array | null = null,
): typeof fetch {
    return async (input: RequestInfo | URL, _init?: RequestInit) => {
        const bytes = body ?? new Uint8Array([1, 2, 3]);
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        return new Response(buffer as ArrayBuffer, { status });
    };
}

function makeThrowingFetch(error: unknown): typeof fetch {
    return async (_input: RequestInfo | URL, _init?: RequestInit) => {
        throw error;
    };
}

describe("fetchWalrusBlob", () => {
    describe("正常系", () => {
        it("正しい URL を叩き bytes を返す", async () => {
            const expectedBytes = new Uint8Array([10, 20, 30, 40]);
            let capturedUrl: string | undefined;
            const fakeFetch: typeof fetch = async (input) => {
                capturedUrl =
                    typeof input === "string"
                        ? input
                        : input instanceof URL
                          ? input.href
                          : input.url;
                return new Response(expectedBytes, { status: 200 });
            };

            const result = await fetchWalrusBlob(WALRUS_URI, makeEnv(), fakeFetch);

            expect(capturedUrl).toBe(`${AGGREGATOR_URL}/v1/blobs/${BLOB_ID}`);
            expect(result).toBeInstanceOf(ArrayBuffer);
            const resultBytes = new Uint8Array(result);
            expect(Array.from(resultBytes)).toEqual(Array.from(expectedBytes));
        });

        it("別の blob ID でも正しい URL を組み立てる", async () => {
            const otherId = "xyz999";
            let capturedUrl: string | undefined;
            const fakeFetch: typeof fetch = async (input) => {
                capturedUrl =
                    typeof input === "string"
                        ? input
                        : input instanceof URL
                          ? input.href
                          : input.url;
                return new Response(new Uint8Array([0xff]), { status: 200 });
            };

            await fetchWalrusBlob(`walrus://blob/${otherId}`, makeEnv(), fakeFetch);

            expect(capturedUrl).toBe(`${AGGREGATOR_URL}/v1/blobs/${otherId}`);
        });

        it("fetch 引数を省略した場合はグローバル fetch を使う（型検証のみ）", () => {
            // fetchImpl のデフォルト引数として global fetch が設定されていることを
            // シグネチャレベルで確認するためのプレースホルダー
            expect(typeof fetchWalrusBlob).toBe("function");
        });
    });

    describe("WALRUS_AGGREGATOR_URL 未設定 → walrus_fetch_failed", () => {
        it("WALRUS_AGGREGATOR_URL が undefined のとき walrus_fetch_failed を throw する", async () => {
            const env = makeEnvEmpty();

            await expect(
                fetchWalrusBlob(WALRUS_URI, env, makeFakeFetch(200)),
            ).rejects.toSatisfy(
                (e: unknown) =>
                    e instanceof AffectedCellsProofError && e.code === "walrus_fetch_failed",
            );
        });

        it("WALRUS_AGGREGATOR_URL が空文字のとき walrus_fetch_failed を throw する", async () => {
            const env = makeEnv("");

            await expect(
                fetchWalrusBlob(WALRUS_URI, env, makeFakeFetch(200)),
            ).rejects.toSatisfy(
                (e: unknown) =>
                    e instanceof AffectedCellsProofError && e.code === "walrus_fetch_failed",
            );
        });
    });

    describe("URI 形式不正 → invalid_request", () => {
        it("http:// scheme は invalid_request を throw する", async () => {
            await expect(
                fetchWalrusBlob("https://example.com/blob/abc", makeEnv(), makeFakeFetch(200)),
            ).rejects.toSatisfy(
                (e: unknown) =>
                    e instanceof AffectedCellsProofError && e.code === "invalid_request",
            );
        });

        it("walrus:// だが /blob/ でない場合は invalid_request を throw する", async () => {
            await expect(
                fetchWalrusBlob("walrus://other/abc123", makeEnv(), makeFakeFetch(200)),
            ).rejects.toSatisfy(
                (e: unknown) =>
                    e instanceof AffectedCellsProofError && e.code === "invalid_request",
            );
        });

        it("walrus://blob/ で id が空の場合は invalid_request を throw する", async () => {
            await expect(
                fetchWalrusBlob("walrus://blob/", makeEnv(), makeFakeFetch(200)),
            ).rejects.toSatisfy(
                (e: unknown) =>
                    e instanceof AffectedCellsProofError && e.code === "invalid_request",
            );
        });

        it("空文字は invalid_request を throw する", async () => {
            await expect(
                fetchWalrusBlob("", makeEnv(), makeFakeFetch(200)),
            ).rejects.toSatisfy(
                (e: unknown) =>
                    e instanceof AffectedCellsProofError && e.code === "invalid_request",
            );
        });

        it("walrus://blob なしの場合は invalid_request を throw する", async () => {
            await expect(
                fetchWalrusBlob("walrus://abc123", makeEnv(), makeFakeFetch(200)),
            ).rejects.toSatisfy(
                (e: unknown) =>
                    e instanceof AffectedCellsProofError && e.code === "invalid_request",
            );
        });
    });

    describe("非 200 レスポンス → walrus_fetch_failed", () => {
        it("404 レスポンスは walrus_fetch_failed を throw する", async () => {
            await expect(
                fetchWalrusBlob(WALRUS_URI, makeEnv(), makeFakeFetch(404)),
            ).rejects.toSatisfy(
                (e: unknown) =>
                    e instanceof AffectedCellsProofError && e.code === "walrus_fetch_failed",
            );
        });

        it("500 レスポンスは walrus_fetch_failed を throw する", async () => {
            await expect(
                fetchWalrusBlob(WALRUS_URI, makeEnv(), makeFakeFetch(500)),
            ).rejects.toSatisfy(
                (e: unknown) =>
                    e instanceof AffectedCellsProofError && e.code === "walrus_fetch_failed",
            );
        });

        it("403 レスポンスは walrus_fetch_failed を throw する", async () => {
            await expect(
                fetchWalrusBlob(WALRUS_URI, makeEnv(), makeFakeFetch(403)),
            ).rejects.toSatisfy(
                (e: unknown) =>
                    e instanceof AffectedCellsProofError && e.code === "walrus_fetch_failed",
            );
        });
    });

    describe("fetch が例外 throw → walrus_fetch_failed", () => {
        it("fetch が Error を throw した場合は walrus_fetch_failed でラップする", async () => {
            const networkError = new Error("Network unreachable");
            await expect(
                fetchWalrusBlob(WALRUS_URI, makeEnv(), makeThrowingFetch(networkError)),
            ).rejects.toSatisfy(
                (e: unknown) =>
                    e instanceof AffectedCellsProofError && e.code === "walrus_fetch_failed",
            );
        });

        it("fetch が文字列を throw した場合も walrus_fetch_failed でラップする", async () => {
            await expect(
                fetchWalrusBlob(WALRUS_URI, makeEnv(), makeThrowingFetch("connection refused")),
            ).rejects.toSatisfy(
                (e: unknown) =>
                    e instanceof AffectedCellsProofError && e.code === "walrus_fetch_failed",
            );
        });
    });
});
