import { EnokiClient } from "@mysten/enoki";
import {
    type EnokiMembershipError,
    parseEnokiMembershipExecuteRequest,
    readEnokiMembershipExecuteConfig,
} from "../shared";

export const runtime = "nodejs";

type ExecuteErrorCode = EnokiMembershipError["code"] | "enoki_execute_failed";

interface ExecuteError {
    readonly code: ExecuteErrorCode;
    readonly message: string;
}

function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function errorResponse(error: ExecuteError, status: number): Response {
    return jsonResponse({ error }, status);
}

export async function POST(request: Request): Promise<Response> {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return errorResponse(
            {
                code: "invalid_request",
                message: "Request body must be valid JSON.",
            },
            400,
        );
    }

    const requestResult = parseEnokiMembershipExecuteRequest(body);
    if (!requestResult.ok) {
        return errorResponse(requestResult.error, 400);
    }

    const configResult = readEnokiMembershipExecuteConfig();
    if (!configResult.ok) {
        return errorResponse(configResult.error, 500);
    }

    const enoki = new EnokiClient({ apiKey: configResult.config.enokiPrivateApiKey });
    try {
        const executed = await enoki.executeSponsoredTransaction({
            digest: requestResult.request.digest,
            signature: requestResult.request.signature,
        });

        return jsonResponse({ digest: executed.digest }, 200);
    } catch (err) {
        console.error(
            "[enoki-membership-execute] executeSponsoredTransaction failed:",
            err instanceof Error ? err.message : String(err),
        );
        return errorResponse(
            {
                code: "enoki_execute_failed",
                message: "Could not execute the membership transaction. Please try again.",
            },
            502,
        );
    }
}
