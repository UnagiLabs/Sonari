import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const createSponsoredTransactionMock = vi.hoisted(() => vi.fn());
const enokiClientConstructorMock = vi.hoisted(() => vi.fn());

vi.mock("@mysten/enoki", () => ({
    EnokiClient: vi.fn(function EnokiClient(args: unknown) {
        enokiClientConstructorMock(args);
        return {
            createSponsoredTransaction: createSponsoredTransactionMock,
        };
    }),
}));

const PACKAGE_ID = `0x${"12".repeat(32)}`;
const SENDER = `0x${"34".repeat(32)}`;
const PRIVATE_API_KEY = "enoki-private-api-key";
const ALLOWED_MOVE_CALL_TARGETS = [
    `${PACKAGE_ID}::accessor::register_member`,
    `${PACKAGE_ID}::accessor::new_residence_proof_step_left`,
    `${PACKAGE_ID}::accessor::new_residence_proof_step_right`,
] as const;

const originalEnv = {
    ENOKI_PRIVATE_API_KEY: process.env.ENOKI_PRIVATE_API_KEY,
    NEXT_PUBLIC_SUI_NETWORK: process.env.NEXT_PUBLIC_SUI_NETWORK,
    NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID:
        process.env.NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID,
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
    process.env.NEXT_PUBLIC_SUI_NETWORK = "testnet";
    process.env.NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID = PACKAGE_ID;
}

async function buildKindBase64(): Promise<string> {
    const tx = new Transaction();
    tx.moveCall({ target: ALLOWED_MOVE_CALL_TARGETS[0], arguments: [] });
    return toBase64(await tx.build({ onlyTransactionKind: true }));
}

function makeRequest(body: unknown): Request {
    return new Request("http://localhost/api/enoki/membership/sponsor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

describe("POST /api/enoki/membership/sponsor", () => {
    beforeEach(() => {
        configureEnv();
        vi.clearAllMocks();
        createSponsoredTransactionMock.mockResolvedValue({
            digest: "sponsored-digest",
            bytes: "sponsored-bytes",
        });
    });

    afterEach(() => {
        restoreEnv();
    });

    it("creates a sponsored transaction with the server-side Enoki private API key", async () => {
        const transactionBlockKindBytes = await buildKindBase64();

        const res = await POST(makeRequest({ sender: SENDER, transactionBlockKindBytes }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({
            digest: "sponsored-digest",
            bytes: "sponsored-bytes",
        });
        expect(enokiClientConstructorMock).toHaveBeenCalledWith({ apiKey: PRIVATE_API_KEY });
        expect(createSponsoredTransactionMock).toHaveBeenCalledWith({
            network: "testnet",
            sender: SENDER,
            transactionKindBytes: transactionBlockKindBytes,
            allowedMoveCallTargets: [...ALLOWED_MOVE_CALL_TARGETS],
        });
        expect(createSponsoredTransactionMock.mock.calls[0]?.[0]).not.toHaveProperty("allowedAddresses");
    });

    it("does not expose the private API key in the success response", async () => {
        const transactionBlockKindBytes = await buildKindBase64();

        const res = await POST(makeRequest({ sender: SENDER, transactionBlockKindBytes }));
        const text = await res.text();

        expect(text).not.toContain(PRIVATE_API_KEY);
    });

    it("returns 400 with a structured error for invalid JSON", async () => {
        delete process.env.ENOKI_PRIVATE_API_KEY;
        const res = await POST(
            new Request("http://localhost/api/enoki/membership/sponsor", {
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
        expect(createSponsoredTransactionMock).not.toHaveBeenCalled();
    });

    it("returns 400 with a structured error for body validation failures", async () => {
        const transactionBlockKindBytes = await buildKindBase64();

        const res = await POST(makeRequest({ sender: "not-an-address", transactionBlockKindBytes }));

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
            error: {
                code: "invalid_sender",
                message: "sender must be a Sui address.",
            },
        });
        expect(enokiClientConstructorMock).not.toHaveBeenCalled();
        expect(createSponsoredTransactionMock).not.toHaveBeenCalled();
    });

    it("returns 500 with a controlled structured error when config is missing", async () => {
        delete process.env.ENOKI_PRIVATE_API_KEY;
        const transactionBlockKindBytes = await buildKindBase64();

        const res = await POST(makeRequest({ sender: SENDER, transactionBlockKindBytes }));

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
        createSponsoredTransactionMock.mockRejectedValueOnce(new Error("upstream failed"));
        const transactionBlockKindBytes = await buildKindBase64();

        const res = await POST(makeRequest({ sender: SENDER, transactionBlockKindBytes }));

        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({
            error: {
                code: "enoki_sponsorship_failed",
                message: "Could not sponsor the membership transaction. Please try again.",
            },
        });
    });
});
