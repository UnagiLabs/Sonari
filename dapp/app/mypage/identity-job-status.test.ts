import { describe, expect, it } from "vitest";
import {
    fetchIdentityJobStatus,
    identityStatusMessage,
    parseIdentityJobStatusResponse,
} from "./identity-job-status";

const OWNER = `0x${"33".repeat(32)}`;
const MEMBERSHIP_ID = `0x${"22".repeat(32)}`;
const NOW_MS = 1_800_000_000_000;

describe("identityStatusMessage", () => {
    it("matches the runner personal-message format", () => {
        expect(
            identityStatusMessage({
                owner: OWNER,
                membershipId: MEMBERSHIP_ID,
                issuedAtMs: NOW_MS,
            }),
        ).toBe(
            [
                "Sonari identity verification status",
                `owner:${OWNER}`,
                `membership_id:${MEMBERSHIP_ID}`,
                `issued_at_ms:${NOW_MS}`,
            ].join("\n"),
        );
    });
});

describe("parseIdentityJobStatusResponse", () => {
    it.each(["none", "queued", "processing", "completed", "rejected", "failed"] as const)(
        "parses %s",
        (status) => {
            expect(parseIdentityJobStatusResponse({ ok: true, status })).toEqual({ status });
        },
    );

    it("preserves safe public metadata", () => {
        expect(
            parseIdentityJobStatusResponse({
                ok: true,
                status: "completed",
                updated_at_ms: NOW_MS,
                completed_at_ms: NOW_MS + 10,
                tx_digest: "A1B2C3",
            }),
        ).toEqual({
            status: "completed",
            updatedAtMs: NOW_MS,
            completedAtMs: NOW_MS + 10,
            txDigest: "A1B2C3",
        });
    });

    it.each([
        null,
        [],
        { ok: false, status: "queued" },
        { ok: true, status: "verified" },
        { ok: true },
    ])("maps malformed response to unavailable", (body) => {
        expect(parseIdentityJobStatusResponse(body)).toEqual({ status: "unavailable" });
    });
});

describe("fetchIdentityJobStatus", () => {
    it("returns unavailable when endpoint is not configured", async () => {
        await expect(
            fetchIdentityJobStatus({
                endpointUrl: "",
                owner: OWNER,
                membershipId: MEMBERSHIP_ID,
                signPersonalMessage: async () => ({ signature: "sig" }),
            }),
        ).resolves.toEqual({ status: "unavailable" });
    });

    it("signs the canonical message and posts the status request", async () => {
        const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
        const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
            calls.push({ url: String(url), init: init ?? {} });
            return response({ ok: true, status: "queued", updated_at_ms: NOW_MS });
        };
        const signedMessages: string[] = [];

        const result = await fetchIdentityJobStatus({
            endpointUrl: "https://status.example",
            owner: OWNER,
            membershipId: MEMBERSHIP_ID,
            nowMs: NOW_MS,
            fetchImpl: fetchImpl as typeof fetch,
            signPersonalMessage: async ({ message }) => {
                signedMessages.push(new TextDecoder().decode(message));
                return { signature: "signed" };
            },
        });

        expect(result).toEqual({ status: "queued", updatedAtMs: NOW_MS });
        expect(signedMessages).toEqual([
            identityStatusMessage({ owner: OWNER, membershipId: MEMBERSHIP_ID, issuedAtMs: NOW_MS }),
        ]);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe("https://status.example");
        expect(calls[0]?.init.method).toBe("POST");
        expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
            owner: OWNER,
            membership_id: MEMBERSHIP_ID,
            issued_at_ms: NOW_MS,
            signature: "signed",
        });
    });

    it("maps HTTP and signing failures to unavailable", async () => {
        await expect(
            fetchIdentityJobStatus({
                endpointUrl: "https://status.example",
                owner: OWNER,
                membershipId: MEMBERSHIP_ID,
                fetchImpl: (async () => response({ ok: false }, 500)) as typeof fetch,
                signPersonalMessage: async () => ({ signature: "signed" }),
            }),
        ).resolves.toEqual({ status: "unavailable" });

        await expect(
            fetchIdentityJobStatus({
                endpointUrl: "https://status.example",
                owner: OWNER,
                membershipId: MEMBERSHIP_ID,
                signPersonalMessage: async () => {
                    throw new Error("user rejected");
                },
            }),
        ).resolves.toEqual({ status: "unavailable" });
    });
});

function response(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}
