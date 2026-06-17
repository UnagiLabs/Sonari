import { EnokiClient } from "@mysten/enoki";
import {
    type EnokiMembershipError,
    parseEnokiMembershipRequest,
    readEnokiMembershipConfig,
    readEnokiMembershipPackageId,
} from "../shared";

export const runtime = "nodejs";

type SponsorErrorCode = EnokiMembershipError["code"] | "enoki_sponsorship_failed";

interface SponsorError {
    readonly code: SponsorErrorCode;
    readonly message: string;
}

function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function errorResponse(error: SponsorError, status: number): Response {
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

    const packageIdResult = readEnokiMembershipPackageId();
    if (!packageIdResult.ok) {
        return errorResponse(packageIdResult.error, 500);
    }

    const requestResult = parseEnokiMembershipRequest(body, packageIdResult.value);
    if (!requestResult.ok) {
        return errorResponse(requestResult.error, 400);
    }

    const configResult = readEnokiMembershipConfig();
    if (!configResult.ok) {
        return errorResponse(configResult.error, 500);
    }

    const { config } = configResult;
    const enoki = new EnokiClient({ apiKey: config.enokiPrivateApiKey });
    try {
        const sponsored = await enoki.createSponsoredTransaction({
            network: config.network,
            sender: requestResult.request.sender,
            transactionKindBytes: requestResult.request.transactionBlockKindBytes,
            allowedMoveCallTargets: [...config.allowedMoveCallTargets],
        });

        return jsonResponse({ digest: sponsored.digest, bytes: sponsored.bytes }, 200);
    } catch (err) {
        console.error(
            "[enoki-membership-sponsor] createSponsoredTransaction failed:",
            err instanceof Error ? err.message : String(err),
        );
        return errorResponse(
            {
                code: "enoki_sponsorship_failed",
                message: "Could not sponsor the membership transaction. Please try again.",
            },
            502,
        );
    }
}
