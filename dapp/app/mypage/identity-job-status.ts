export type IdentityJobStatus =
    | "none"
    | "queued"
    | "processing"
    | "completed"
    | "rejected"
    | "failed"
    | "unavailable";

export interface IdentityJobStatusResult {
    readonly status: IdentityJobStatus;
    readonly updatedAtMs?: number;
    readonly completedAtMs?: number;
    readonly txDigest?: string;
}

export interface IdentityJobStatusInput {
    readonly endpointUrl: string;
    readonly owner: string;
    readonly membershipId: string;
    readonly nowMs?: number;
    readonly fetchImpl?: typeof fetch;
    readonly signPersonalMessage: (input: {
        readonly message: Uint8Array;
    }) => Promise<{ readonly signature: string }>;
}

export async function fetchIdentityJobStatus(
    input: IdentityJobStatusInput,
): Promise<IdentityJobStatusResult> {
    const endpointUrl = input.endpointUrl.trim();
    if (endpointUrl.length === 0) {
        return { status: "unavailable" };
    }

    const issuedAtMs = input.nowMs ?? Date.now();
    const message = identityStatusMessage({
        owner: input.owner,
        membershipId: input.membershipId,
        issuedAtMs,
    });

    let signature: string;
    try {
        const signed = await input.signPersonalMessage({
            message: new TextEncoder().encode(message),
        });
        signature = signed.signature;
    } catch {
        return { status: "unavailable" };
    }

    let response: Response;
    try {
        response = await (input.fetchImpl ?? fetch)(endpointUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                owner: input.owner,
                membership_id: input.membershipId,
                issued_at_ms: issuedAtMs,
                signature,
            }),
        });
    } catch {
        return { status: "unavailable" };
    }

    if (!response.ok) {
        return { status: "unavailable" };
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        return { status: "unavailable" };
    }
    return parseIdentityJobStatusResponse(body);
}

export function identityStatusMessage(input: {
    readonly owner: string;
    readonly membershipId: string;
    readonly issuedAtMs: number;
}): string {
    return [
        "Sonari identity verification status",
        `owner:${input.owner}`,
        `membership_id:${input.membershipId}`,
        `issued_at_ms:${input.issuedAtMs}`,
    ].join("\n");
}

export function parseIdentityJobStatusResponse(input: unknown): IdentityJobStatusResult {
    if (!isRecord(input) || input.ok !== true) {
        return { status: "unavailable" };
    }
    const status = parseStatus(input.status);
    if (status === null) {
        return { status: "unavailable" };
    }
    const updatedAtMs = optionalNumber(input.updated_at_ms);
    const completedAtMs = optionalNumber(input.completed_at_ms);
    const txDigest = optionalString(input.tx_digest);
    return {
        status,
        ...(updatedAtMs === undefined ? {} : { updatedAtMs }),
        ...(completedAtMs === undefined ? {} : { completedAtMs }),
        ...(txDigest === undefined ? {} : { txDigest }),
    };
}

function parseStatus(input: unknown): IdentityJobStatus | null {
    switch (input) {
        case "none":
        case "queued":
        case "processing":
        case "completed":
        case "rejected":
        case "failed":
            return input;
        default:
            return null;
    }
}

function optionalNumber(input: unknown): number | undefined {
    return typeof input === "number" && Number.isSafeInteger(input) && input >= 0
        ? input
        : undefined;
}

function optionalString(input: unknown): string | undefined {
    return typeof input === "string" && input.length > 0 ? input : undefined;
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}
