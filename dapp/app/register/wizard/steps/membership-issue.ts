"use client";

import { Transaction } from "@mysten/sui/transactions";
import {
    type ProofStep,
    expectArray,
    expectBoolean,
    expectKeys,
    expectNonNegativeSafeInteger,
    expectPrefixedHex32,
    expectRecord,
    expectString,
    computeIdentityStatementHash,
} from "@sonari/proof-core";

export const MEMBERSHIP_TERMS_VERSION = 1;

export interface ResidenceProofResponse {
    readonly h3_index: string;
    readonly allowlist_version: number;
    readonly geo_resolution: number;
    readonly merkle_root: string;
    readonly proof: readonly ProofStep[];
}

export interface MembershipIssueTransactionObjects {
    readonly pauseState: string;
    readonly membershipRegistry: string;
    readonly allowedResidenceCellRegistry: string;
}

export interface FetchResidenceProofInput {
    readonly workerUrl: string;
    readonly homeCell: string;
    readonly fetchImpl?: typeof fetch;
}

export interface BuildRegisterMemberTransactionInput {
    readonly senderAddress?: string;
    readonly packageId: string;
    readonly objects: MembershipIssueTransactionObjects;
    readonly homeCell: string;
    readonly residenceProof: ResidenceProofResponse;
    readonly termsVersion?: number;
    readonly signedStatementHash?: string;
}

export interface RegisterMemberTransactionResult {
    readonly transaction: Transaction;
}

type MembershipIssueErrorCode =
    | "worker_url_missing"
    | "proof_fetch_failed"
    | "invalid_proof_response"
    | "residence_cell_not_allowed";

export class MembershipIssueError extends Error {
    readonly code: MembershipIssueErrorCode;

    constructor(code: MembershipIssueErrorCode, message: string) {
        super(message);
        this.name = "MembershipIssueError";
        this.code = code;
    }
}

export async function fetchResidenceProof(
    input: FetchResidenceProofInput,
): Promise<ResidenceProofResponse> {
    const workerUrl = input.workerUrl.trim();
    if (workerUrl.length === 0) {
        throw new MembershipIssueError(
            "worker_url_missing",
            "Residence proof worker URL is not configured.",
        );
    }

    const fetchImpl = input.fetchImpl ?? fetch;
    const requestUrl = buildResidenceProofRequestUrl(workerUrl, input.homeCell);

    let response: Response;
    try {
        response = await fetchImpl(requestUrl);
    } catch (error) {
        throw new MembershipIssueError(
            "proof_fetch_failed",
            error instanceof Error ? error.message : "Residence proof request failed.",
        );
    }

    if (response.status === 404) {
        throw new MembershipIssueError(
            "residence_cell_not_allowed",
            "Selected residence cell is not in the allowlist.",
        );
    }

    if (!response.ok) {
        throw new MembershipIssueError(
            "proof_fetch_failed",
            `Residence proof worker returned HTTP ${response.status}.`,
        );
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch (error) {
        throw new MembershipIssueError(
            "invalid_proof_response",
            error instanceof Error ? error.message : "Residence proof response is invalid.",
        );
    }

    return parseResidenceProofResponse(body, input.homeCell);
}

export function buildRegisterMemberTransaction(
    input: BuildRegisterMemberTransactionInput,
): RegisterMemberTransactionResult {
    const homeCell = requireDecimalU64String(input.homeCell, "homeCell");
    const termsVersion = input.termsVersion ?? MEMBERSHIP_TERMS_VERSION;
    const signedStatementHash =
        input.signedStatementHash ?? computeIdentityStatementHash(termsVersion);
    const tx = new Transaction();
    if (input.senderAddress !== undefined) {
        tx.setSender(input.senderAddress);
    }

    const proofSteps = input.residenceProof.proof.map((step) =>
        tx.moveCall({
            target: `${input.packageId}::accessor::${step.sibling_on_left ? "new_residence_proof_step_left" : "new_residence_proof_step_right"}`,
            arguments: [tx.pure.vector("u8", hexToByteArray(step.sibling_hash))],
        }),
    );
    const residenceProof = tx.makeMoveVec({
        type: `${input.packageId}::allowed_residence_cell::ProofStep`,
        elements: proofSteps,
    });

    tx.moveCall({
        target: `${input.packageId}::accessor::register_member`,
        arguments: [
            tx.object(input.objects.pauseState),
            tx.object(input.objects.membershipRegistry),
            tx.object(input.objects.allowedResidenceCellRegistry),
            tx.pure.u64(BigInt(homeCell)),
            residenceProof,
            tx.pure.u64(BigInt(termsVersion)),
            tx.pure.vector(
                "u8",
                hexToByteArray(expectPrefixedHex32("signedStatementHash", signedStatementHash)),
            ),
        ],
    });

    return { transaction: tx };
}

function buildResidenceProofRequestUrl(workerUrl: string, homeCell: string): string {
    const base = workerUrl.replace(/\/+$/u, "");
    const url = new URL(`${base}/api/residence-proof`);
    url.searchParams.set("h3_index", homeCell);
    return url.toString();
}

function parseResidenceProofResponse(value: unknown, expectedHomeCell: string): ResidenceProofResponse {
    const record = expectRecord("residence proof response", value);
    expectKeys("residence proof response", record, [
        "h3_index",
        "allowlist_version",
        "geo_resolution",
        "merkle_root",
        "proof",
    ]);

    const h3_index = requireDecimalU64String(record.h3_index, "h3_index");
    if (h3_index !== expectedHomeCell) {
        throw new MembershipIssueError(
            "invalid_proof_response",
            "h3_index does not match the selected residence cell.",
        );
    }

    const proof = expectArray("proof", record.proof).map(parseProofStep);
    return {
        h3_index,
        allowlist_version: expectNonNegativeSafeInteger(
            "allowlist_version",
            record.allowlist_version,
        ),
        geo_resolution: expectNonNegativeSafeInteger("geo_resolution", record.geo_resolution),
        merkle_root: expectPrefixedHex32("merkle_root", record.merkle_root),
        proof,
    };
}

function parseProofStep(value: unknown): ProofStep {
    const record = expectRecord("proof step", value);
    expectKeys("proof step", record, ["sibling_on_left", "sibling_hash"]);
    return {
        sibling_on_left: expectBoolean("sibling_on_left", record.sibling_on_left),
        sibling_hash: expectPrefixedHex32("sibling_hash", record.sibling_hash),
    };
}

function requireDecimalU64String(value: unknown, fieldName: string): string {
    const text = expectString(fieldName, value);
    if (!/^(0|[1-9]\d*)$/u.test(text)) {
        throw new Error(`${fieldName} must be a decimal u64 string`);
    }
    return text;
}

function hexToByteArray(value: string): number[] {
    const hex = value.startsWith("0x") ? value.slice(2) : value;
    const bytes: number[] = [];
    for (let offset = 0; offset < hex.length; offset += 2) {
        bytes.push(Number.parseInt(hex.slice(offset, offset + 2), 16));
    }
    return bytes;
}
