import { signRequest } from "@worldcoin/idkit/signing";
import { WORLD_ID_ACTION } from "../../../register/identity/world-id-action";

export const runtime = "nodejs";

export interface RpSignature {
    readonly sig: string;
    readonly nonce: string;
    readonly createdAt: number;
    readonly expiresAt: number;
}

function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function parseAction(body: unknown): { ok: true; action: string } | { ok: false; error: string } {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return { ok: false, error: "Invalid request" };
    }
    const record = body as Record<string, unknown>;
    if (typeof record.action !== "string") {
        return { ok: false, error: "Invalid request" };
    }
    return { ok: true, action: record.action };
}

function readSigningKey(): { ok: true; key: string } | { ok: false; error: string } {
    const key = process.env.WORLD_ID_RP_SIGNING_KEY;
    if (!key || key.trim().length === 0) {
        return { ok: false, error: "World ID signing is not configured" };
    }
    return { ok: true, key };
}

function callSignRequest(
    signingKeyHex: string,
    action: string,
): { ok: true; result: RpSignature } | { ok: false; error: string } {
    try {
        const result = signRequest({ signingKeyHex, action, ttl: 300 });
        const signature: RpSignature = {
            sig: result.sig,
            nonce: result.nonce,
            createdAt: result.createdAt,
            expiresAt: result.expiresAt,
        };
        return { ok: true, result: signature };
    } catch (err) {
        console.error("[rp-signature] signRequest failed:", err instanceof Error ? err.message : String(err));
        return { ok: false, error: "Signing failed" };
    }
}

export async function POST(request: Request): Promise<Response> {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "Invalid request" }, 400);
    }

    const actionResult = parseAction(body);
    if (!actionResult.ok) {
        return jsonResponse({ error: actionResult.error }, 400);
    }

    const { action } = actionResult;
    if (action !== WORLD_ID_ACTION) {
        return jsonResponse({ error: "Invalid request" }, 400);
    }

    const keyResult = readSigningKey();
    if (!keyResult.ok) {
        return jsonResponse({ error: keyResult.error }, 500);
    }

    const signResult = callSignRequest(keyResult.key, action);
    if (!signResult.ok) {
        return jsonResponse({ error: signResult.error }, 500);
    }

    return jsonResponse(signResult.result, 200);
}
