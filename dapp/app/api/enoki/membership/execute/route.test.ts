import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const executeSponsoredTransactionMock = vi.hoisted(() => vi.fn());
const enokiClientConstructorMock = vi.hoisted(() => vi.fn());

vi.mock("@mysten/enoki", () => ({
    EnokiClient: vi.fn(function EnokiClient(args: unknown) {
        enokiClientConstructorMock(args);
        return {
            executeSponsoredTransaction: executeSponsoredTransactionMock,
        };
    }),
}));

const DIGEST = "8oM2nT3kQ4abcDEFghiJKLmnopQRstUVwxyz1234567";
const EXECUTED_DIGEST = "11111111111111111111111111111111";
const SIGNATURE = "AQIDBA==";
const PRIVATE_API_KEY = "enoki-private-api-key";

const originalEnv = {
    ENOKI_PRIVATE_API_KEY: process.env.ENOKI_PRIVATE_API_KEY,
    SONARI_SUI_NETWORK: process.env.SONARI_SUI_NETWORK,
    NEXT_PUBLIC_SUI_NETWORK: process.env.NEXT_PUBLIC_SUI_NETWORK,
};

function restoreEnv(): void {
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
}

function configureEnv(): void {
    process.env.ENOKI_PRIVATE_API_KEY = PRIVATE_API_KEY;
    process.env.SONARI_SUI_NETWORK = "testnet";
    process.env.NEXT_PUBLIC_SUI_NETWORK = "mainnet";
}

function makeRequest(body: unknown): Request {
    return new Request("http://localhost/api/enoki/membership/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

describe("POST /api/enoki/membership/execute", () => {
    beforeEach(() => {
        configureEnv();
        vi.clearAllMocks();
        executeSponsoredTransactionMock.mockResolvedValue({ digest: EXECUTED_DIGEST });
    });

    afterEach(() => {
        restoreEnv();
    });

    it("executes a sponsored transaction with the server-side Enoki private API key", async () => {
        const res = await POST(makeRequest({ digest: DIGEST, signature: SIGNATURE }));

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ digest: EXECUTED_DIGEST });
        expect(enokiClientConstructorMock).toHaveBeenCalledWith({ apiKey: PRIVATE_API_KEY });
        expect(executeSponsoredTransactionMock).toHaveBeenCalledWith({
            digest: DIGEST,
            signature: SIGNATURE,
        });
    });

    it("does not expose the private API key in the success response", async () => {
        const res = await POST(makeRequest({ digest: DIGEST, signature: SIGNATURE }));
        const text = await res.text();

        expect(text).toBe(JSON.stringify({ digest: EXECUTED_DIGEST }));
        expect(text).not.toContain(PRIVATE_API_KEY);
    });

    it("returns 400 with a structured error for invalid JSON", async () => {
        delete process.env.ENOKI_PRIVATE_API_KEY;
        const res = await POST(
            new Request("http://localhost/api/enoki/membership/execute", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "not-json{{{",
            }),
        );

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
            error: {
                code: "invalid_request",
                message: "Request body must be valid JSON.",
            },
        });
        expect(executeSponsoredTransactionMock).not.toHaveBeenCalled();
    });

    it("returns 400 with a structured error for an invalid digest", async () => {
        const res = await POST(makeRequest({ digest: "not-a-digest", signature: SIGNATURE }));

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
            error: {
                code: "invalid_digest",
                message: "digest must be a Sui transaction digest.",
            },
        });
        expect(enokiClientConstructorMock).not.toHaveBeenCalled();
    });

    it("returns 400 with a structured error for an invalid signature", async () => {
        const res = await POST(makeRequest({ digest: DIGEST, signature: "not base64!" }));

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
            error: {
                code: "invalid_signature",
                message: "signature must be base64.",
            },
        });
        expect(enokiClientConstructorMock).not.toHaveBeenCalled();
    });

    it("returns 500 with a controlled structured error when the private key is missing", async () => {
        delete process.env.ENOKI_PRIVATE_API_KEY;

        const res = await POST(makeRequest({ digest: DIGEST, signature: SIGNATURE }));

        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({
            error: {
                code: "missing_enoki_private_api_key",
                message: "Enoki sponsorship is not configured.",
            },
        });
        expect(enokiClientConstructorMock).not.toHaveBeenCalled();
    });

    it("maps Enoki failures to a UI-friendly 502 error", async () => {
        executeSponsoredTransactionMock.mockRejectedValueOnce(new Error("upstream failed"));

        const res = await POST(makeRequest({ digest: DIGEST, signature: SIGNATURE }));

        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({
            error: {
                code: "enoki_execute_failed",
                message: "Could not execute the membership transaction. Please try again.",
            },
        });
    });
});
