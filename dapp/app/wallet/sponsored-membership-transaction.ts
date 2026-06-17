import type { ClientWithCoreApi } from "@mysten/sui/client";
import type { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";

type SponsoredMembershipTransactionStage = "build" | "sponsor" | "sign" | "execute";

interface SponsoredMembershipSigner {
    signTransaction(args: { readonly transaction: string }): Promise<{
        readonly bytes: string;
        readonly signature: string;
    }>;
}

interface SponsoredMembershipFetch {
    (url: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export interface ExecuteSponsoredMembershipTransactionInput {
    readonly client: ClientWithCoreApi;
    readonly transaction: Transaction;
    readonly sender: string;
    readonly signer: SponsoredMembershipSigner;
    readonly fetchImpl?: SponsoredMembershipFetch;
}

export interface SponsoredMembershipTransactionSuccess {
    readonly digest: string;
}

interface SponsorResponse {
    readonly digest: string;
    readonly bytes: string;
}

interface ExecuteResponse {
    readonly digest: string;
}

export class SponsoredMembershipTransactionError extends Error {
    readonly stage: SponsoredMembershipTransactionStage;

    constructor(stage: SponsoredMembershipTransactionStage, message: string) {
        super(message);
        this.name = "SponsoredMembershipTransactionError";
        this.stage = stage;
    }
}

export async function executeSponsoredMembershipTransaction({
    client,
    transaction,
    sender,
    signer,
    fetchImpl = fetch,
}: ExecuteSponsoredMembershipTransactionInput): Promise<SponsoredMembershipTransactionSuccess> {
    let transactionBlockKindBytes: string;
    try {
        transactionBlockKindBytes = toBase64(
            await transaction.build({ client, onlyTransactionKind: true }),
        );
    } catch (error) {
        throw new SponsoredMembershipTransactionError("build", errorMessage(error, "Could not build transaction."));
    }

    const sponsored = await postJson<SponsorResponse>(
        fetchImpl,
        "/api/enoki/membership/sponsor",
        {
            sender,
            transactionBlockKindBytes,
        },
        "sponsor",
    );

    let signature: string;
    try {
        const signed = await signer.signTransaction({ transaction: sponsored.bytes });
        if (typeof signed.signature !== "string" || signed.signature.length === 0) {
            throw new Error("Wallet returned an empty transaction signature.");
        }
        signature = signed.signature;
    } catch (error) {
        throw new SponsoredMembershipTransactionError(
            "sign",
            errorMessage(error, "Could not sign sponsored transaction."),
        );
    }

    const executed = await postJson<ExecuteResponse>(
        fetchImpl,
        "/api/enoki/membership/execute",
        {
            digest: sponsored.digest,
            signature,
        },
        "execute",
    );

    return { digest: executed.digest };
}

async function postJson<T extends SponsorResponse | ExecuteResponse>(
    fetchImpl: SponsoredMembershipFetch,
    url: string,
    body: unknown,
    stage: Extract<SponsoredMembershipTransactionStage, "sponsor" | "execute">,
): Promise<T> {
    let response: Response;
    try {
        response = await fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
    } catch (error) {
        throw new SponsoredMembershipTransactionError(
            stage,
            errorMessage(error, `Could not ${stage} membership transaction.`),
        );
    }

    let payload: unknown;
    try {
        payload = await response.json();
    } catch {
        throw new SponsoredMembershipTransactionError(
            stage,
            `Membership ${stage} API returned invalid JSON.`,
        );
    }

    if (!response.ok) {
        throw new SponsoredMembershipTransactionError(stage, apiErrorMessage(payload, response.status));
    }

    return parseSuccessPayload<T>(payload, stage);
}

function parseSuccessPayload<T extends SponsorResponse | ExecuteResponse>(
    payload: unknown,
    stage: Extract<SponsoredMembershipTransactionStage, "sponsor" | "execute">,
): T {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new SponsoredMembershipTransactionError(
            stage,
            `Membership ${stage} API returned an invalid response.`,
        );
    }

    const record = payload as Record<string, unknown>;
    const digest = record.digest;
    if (typeof digest !== "string" || digest.length === 0) {
        throw new SponsoredMembershipTransactionError(
            stage,
            `Membership ${stage} API response is missing digest.`,
        );
    }

    if (stage === "sponsor") {
        const bytes = record.bytes;
        if (typeof bytes !== "string" || bytes.length === 0) {
            throw new SponsoredMembershipTransactionError(
                stage,
                "Membership sponsor API response is missing bytes.",
            );
        }
        return { digest, bytes } as T;
    }

    return { digest } as T;
}

function apiErrorMessage(payload: unknown, status: number): string {
    if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
        const error = (payload as Record<string, unknown>).error;
        if (typeof error === "object" && error !== null && !Array.isArray(error)) {
            const message = (error as Record<string, unknown>).message;
            if (typeof message === "string" && message.length > 0) {
                return message;
            }
        }
    }
    return `Membership sponsorship request failed with HTTP ${status}.`;
}

function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}
