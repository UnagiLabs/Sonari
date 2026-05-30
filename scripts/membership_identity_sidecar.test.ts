import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
    createMembershipIdentitySidecarServer,
    type MembershipIdentityTeeRunner,
} from "./membership_identity_sidecar.js";

const servers: ReturnType<typeof createMembershipIdentitySidecarServer>[] = [];

describe("membership identity sidecar", () => {
    afterEach(async () => {
        await Promise.all(
            servers.splice(0).map(
                (server) =>
                    new Promise<void>((resolve, reject) => {
                        server.close((error) => (error === undefined ? resolve() : reject(error)));
                    }),
            ),
        );
    });

    it("returns a verified signed payload from /identity/verify", async () => {
        const response = await postIdentityVerify(worldIdRequest(), async (request, config) => {
            expect(config.mode).toBe("fixture");
            expect(request).toMatchObject({ provider: "world_id" });
            return {
                ok: true,
                statusCode: 200,
                body: {
                    status: "verified",
                    payload_bcs_hex: `0x${"11".repeat(32)}`,
                    signature: `0x${"22".repeat(64)}`,
                    public_key: `0x${"33".repeat(32)}`,
                },
            };
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            ok: true,
            result: {
                status: "verified",
                payload_bcs_hex: `0x${"11".repeat(32)}`,
                signature: `0x${"22".repeat(64)}`,
                public_key: `0x${"33".repeat(32)}`,
            },
        });
    });

    it("keeps rejected output status-only", async () => {
        const response = await postIdentityVerify(worldIdRequest(), async () => ({
            ok: true,
            statusCode: 200,
            body: {
                status: "rejected",
                error_code: "WORLD_ID_VERIFICATION_FAILED",
            },
        }));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            ok: true,
            result: {
                status: "rejected",
                error_code: "WORLD_ID_VERIFICATION_FAILED",
            },
        });
    });

    it("rejects unexpected top-level request fields", async () => {
        const server = await listen(async () => {
            throw new Error("runner should not be called");
        });
        const response = await fetch(server.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ request: worldIdRequest(), raw_personal_data: "reject" }),
        });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            ok: false,
            error_code: "INVALID_IDENTITY_VERIFY_REQUEST",
        });
    });

    it("fails closed for method, path, malformed JSON, and timeout", async () => {
        const server = await listen(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { ok: true, statusCode: 200, body: { status: "verified" } };
        }, 1);

        const methodResponse = await fetch(server.url, { method: "GET" });
        expect(methodResponse.status).toBe(405);

        const pathResponse = await fetch(server.url.replace("/identity/verify", "/wrong"), {
            method: "POST",
        });
        expect(pathResponse.status).toBe(404);

        const malformedResponse = await fetch(server.url, {
            method: "POST",
            body: "{",
        });
        expect(malformedResponse.status).toBe(400);

        const timeoutResponse = await fetch(server.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ request: worldIdRequest() }),
        });
        expect(timeoutResponse.status).toBe(504);
        await expect(timeoutResponse.json()).resolves.toMatchObject({
            ok: false,
            error_code: "IDENTITY_TEE_TIMEOUT",
        });
    });
});

async function postIdentityVerify(
    request: unknown,
    runner: MembershipIdentityTeeRunner,
): Promise<Response> {
    const server = await listen(runner);
    return fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request }),
    });
}

async function listen(
    runner: MembershipIdentityTeeRunner,
    timeoutMs = 5_000,
): Promise<{ readonly url: string }> {
    const server = createMembershipIdentitySidecarServer({ runner, timeoutMs });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/identity/verify` };
}

function worldIdRequest(): Record<string, unknown> {
    return {
        registry_id: "0x1111111111111111111111111111111111111111111111111111111111111111",
        membership_id: "0x2222222222222222222222222222222222222222222222222222222222222222",
        owner: "0x3333333333333333333333333333333333333333333333333333333333333333",
        provider: "world_id",
        issued_at_ms: 1_800_000_000_000,
        validity_ms: 86_400_000,
        terms_version: 1,
        signed_statement_hash: "0x6666666666666666666666666666666666666666666666666666666666666666",
        world_id: {
            world_app_id: "app_staging_123",
            nullifier_hash: "12345678901234567890",
            merkle_root: "987654321",
            proof: "0xproof",
            verification_level: "orb",
            action: "sonari_membership_register_v1",
            signal_hash: "0x34b7cb40efe9b84ed3c26b036f2691f75c3bb1ecbfa695baf147a372aa2e3268",
        },
    };
}
