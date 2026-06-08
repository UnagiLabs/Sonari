import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// route.ts は存在しない状態でまずこのテストが失敗することを確認（RED フェーズ）
import { POST } from "./route";

const DUMMY_KEY = `0x${"11".repeat(32)}`;
const VALID_ACTION = "sonari_membership_register_v1";

function makeRequest(body: unknown): Request {
    return new Request("http://localhost/api/world-id/rp-signature", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

describe("POST /api/world-id/rp-signature", () => {
    let originalKey: string | undefined;

    beforeEach(() => {
        originalKey = process.env.WORLD_ID_RP_SIGNING_KEY;
        process.env.WORLD_ID_RP_SIGNING_KEY = DUMMY_KEY;
    });

    afterEach(() => {
        if (originalKey === undefined) {
            delete process.env.WORLD_ID_RP_SIGNING_KEY;
        } else {
            process.env.WORLD_ID_RP_SIGNING_KEY = originalKey;
        }
    });

    describe("(a) action 不一致 → 400", () => {
        it("wrong action returns 400", async () => {
            const res = await POST(makeRequest({ action: "wrong_action" }));
            expect(res.status).toBe(400);
        });

        it("wrong action does not return a signature", async () => {
            const res = await POST(makeRequest({ action: "wrong_action" }));
            const body = await res.json();
            expect(body).not.toHaveProperty("sig");
        });
    });

    describe("(b) WORLD_ID_RP_SIGNING_KEY 未設定 → 500", () => {
        it("missing env var returns 500", async () => {
            delete process.env.WORLD_ID_RP_SIGNING_KEY;
            const res = await POST(makeRequest({ action: VALID_ACTION }));
            expect(res.status).toBe(500);
        });

        it("empty env var returns 500", async () => {
            process.env.WORLD_ID_RP_SIGNING_KEY = "";
            const res = await POST(makeRequest({ action: VALID_ACTION }));
            expect(res.status).toBe(500);
        });
    });

    describe("(c) 成功 → 200 with sig/nonce/createdAt/expiresAt", () => {
        it("returns 200 on valid request", async () => {
            const res = await POST(makeRequest({ action: VALID_ACTION }));
            expect(res.status).toBe(200);
        });

        it("response body has sig, nonce, createdAt, expiresAt", async () => {
            const res = await POST(makeRequest({ action: VALID_ACTION }));
            const body = await res.json();
            expect(body).toHaveProperty("sig");
            expect(body).toHaveProperty("nonce");
            expect(body).toHaveProperty("createdAt");
            expect(body).toHaveProperty("expiresAt");
        });

        it("expiresAt - createdAt === 300 (ttl=300 の確認)", async () => {
            const res = await POST(makeRequest({ action: VALID_ACTION }));
            const body = (await res.json()) as { createdAt: number; expiresAt: number };
            expect(body.expiresAt - body.createdAt).toBe(300);
        });
    });

    describe("(d) 鍵非露出 → 応答 body に署名鍵が含まれない", () => {
        it("response body does not contain the signing key hex", async () => {
            const res = await POST(makeRequest({ action: VALID_ACTION }));
            const text = await res.text();
            // ダミー鍵の raw hex（0x なし）が応答に出ていないことを確認
            expect(text).not.toContain("11".repeat(32));
        });

        it("response body does not have signingKeyHex key", async () => {
            const res = await POST(makeRequest({ action: VALID_ACTION }));
            const body = await res.json();
            expect(body).not.toHaveProperty("signingKeyHex");
        });
    });

    describe("(e) nonce freshness → 連続2回の nonce が異なる", () => {
        it("two consecutive calls produce different nonces", async () => {
            const res1 = await POST(makeRequest({ action: VALID_ACTION }));
            const res2 = await POST(makeRequest({ action: VALID_ACTION }));
            const body1 = (await res1.json()) as { nonce: string };
            const body2 = (await res2.json()) as { nonce: string };
            expect(body1.nonce).not.toBe(body2.nonce);
        });
    });

    describe("(f) malformed body → 400", () => {
        it("missing action field returns 400", async () => {
            const res = await POST(makeRequest({}));
            expect(res.status).toBe(400);
        });

        it("action is not a string (number) returns 400", async () => {
            const res = await POST(makeRequest({ action: 42 }));
            expect(res.status).toBe(400);
        });

        it("invalid JSON body returns 400", async () => {
            const res = await POST(
                new Request("http://localhost/api/world-id/rp-signature", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: "not-json{{{",
                }),
            );
            expect(res.status).toBe(400);
        });
    });
});
