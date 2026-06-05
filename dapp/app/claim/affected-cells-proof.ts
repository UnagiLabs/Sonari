import {
    affectedCellLeafHash,
    CellsGenerationMethod,
    CellMetric,
    expectArray,
    expectBoolean,
    expectKeys,
    expectNonNegativeSafeInteger,
    expectPrefixedHex32,
    expectRecord,
    expectString,
    IntensityScale,
    replayProof,
    U64_MAX,
    type AffectedCellLeaf,
    type PrefixedHex32,
    type ProofStep,
} from "@sonari/proof-core";

export type ClaimProofErrorCode =
    | "worker_url_missing"
    | "outside_affected_area"
    | "proof_fetch_failed"
    | "invalid_proof_response"
    | "proof_verification_failed";

export class ClaimProofError extends Error {
    constructor(
        readonly code: ClaimProofErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "ClaimProofError";
    }
}

export interface AffectedCellsProof {
    readonly event_uid: PrefixedHex32;
    readonly event_revision: number;
    readonly h3_index: string;
    readonly affected_cells_root: PrefixedHex32;
    readonly leaf: AffectedCellLeaf;
    readonly proof: ProofStep[];
}

export interface FetchAffectedCellsProofInput {
    readonly workerUrl: string;
    readonly eventUid: string;
    readonly eventRevision: number;
    readonly homeCell: string;
    readonly fetchImpl?: typeof fetch;
}

export async function fetchAffectedCellsProof(
    input: FetchAffectedCellsProofInput,
): Promise<AffectedCellsProof> {
    const workerUrl = input.workerUrl.trim();
    if (workerUrl.length === 0) {
        throw new ClaimProofError(
            "worker_url_missing",
            "Affected cells proof worker URL is not configured.",
        );
    }

    const fetchImpl = input.fetchImpl ?? fetch;
    const requestUrl = buildProofRequestUrl({
        workerUrl,
        eventUid: input.eventUid,
        eventRevision: input.eventRevision,
        homeCell: input.homeCell,
    });

    let response: Response;
    try {
        response = await fetchImpl(requestUrl);
    } catch (error) {
        throw new ClaimProofError(
            "proof_fetch_failed",
            error instanceof Error ? error.message : "Affected cells proof request failed.",
        );
    }

    if (response.status === 404) {
        throw new ClaimProofError(
            "outside_affected_area",
            "MembershipPass home cell is outside this event's affected area.",
        );
    }

    if (!response.ok) {
        throw new ClaimProofError(
            "proof_fetch_failed",
            `Affected cells proof worker returned HTTP ${response.status}.`,
        );
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch (error) {
        throw new ClaimProofError(
            "invalid_proof_response",
            error instanceof Error ? error.message : "Affected cells proof response is invalid.",
        );
    }

    return parseAffectedCellsProofResponse(body);
}

export async function parseAffectedCellsProofResponse(
    value: unknown,
): Promise<AffectedCellsProof> {
    let proof: AffectedCellsProof;
    try {
        proof = parseAffectedCellsProofShape(value);
    } catch (error) {
        if (error instanceof ClaimProofError) {
            throw error;
        }
        throw new ClaimProofError(
            "invalid_proof_response",
            error instanceof Error ? error.message : "Affected cells proof response is invalid.",
        );
    }

    await verifyAffectedCellsProof(proof);
    return proof;
}

function buildProofRequestUrl(input: {
    readonly workerUrl: string;
    readonly eventUid: string;
    readonly eventRevision: number;
    readonly homeCell: string;
}): string {
    const base = input.workerUrl.replace(/\/+$/u, "");
    const url = new URL(
        `${base}/events/${input.eventUid}/revisions/${input.eventRevision}/proof`,
    );
    url.searchParams.set("h3_index", input.homeCell);
    return url.toString();
}

function parseAffectedCellsProofShape(value: unknown): AffectedCellsProof {
    const record = expectRecord("affected cells proof response", value);
    expectKeys("affected cells proof response", record, [
        "event_uid",
        "event_revision",
        "h3_index",
        "affected_cells_root",
        "leaf",
        "proof",
    ]);

    const event_uid = expectPrefixedHex32("event_uid", record.event_uid);
    const event_revision = expectNonNegativeSafeInteger(
        "event_revision",
        record.event_revision,
    );
    const h3_index = expectDecimalU64String("h3_index", record.h3_index);
    const affected_cells_root = expectPrefixedHex32(
        "affected_cells_root",
        record.affected_cells_root,
    );
    const leaf = parseAffectedCellLeaf(record.leaf);
    const proof = expectArray("proof", record.proof).map(parseProofStep);

    if (leaf.event_uid !== event_uid) {
        throw new ClaimProofError("invalid_proof_response", "leaf event_uid does not match.");
    }
    if (leaf.event_revision !== event_revision) {
        throw new ClaimProofError(
            "invalid_proof_response",
            "leaf event_revision does not match.",
        );
    }
    if (leaf.h3_index !== BigInt(h3_index)) {
        throw new ClaimProofError("invalid_proof_response", "leaf h3_index does not match.");
    }

    return {
        event_uid,
        event_revision,
        h3_index,
        affected_cells_root,
        leaf,
        proof,
    };
}

function parseAffectedCellLeaf(value: unknown): AffectedCellLeaf {
    const record = expectRecord("leaf", value);
    expectKeys("leaf", record, [
        "event_uid",
        "event_revision",
        "h3_index",
        "geo_resolution",
        "cell_band",
        "intensity_value",
        "cell_metric",
        "intensity_scale",
        "cells_generation_method",
        "oracle_version",
    ]);

    const cellMetric = expectString("cell_metric", record.cell_metric);
    if (cellMetric !== CellMetric.USGS_MMI) {
        throw new Error(`cell_metric has unknown value: ${cellMetric}`);
    }

    const intensityScale = expectString("intensity_scale", record.intensity_scale);
    if (intensityScale !== IntensityScale.MMI_X100) {
        throw new Error(`intensity_scale has unknown value: ${intensityScale}`);
    }

    const cellsGenerationMethod = expectString(
        "cells_generation_method",
        record.cells_generation_method,
    );
    if (
        cellsGenerationMethod !==
        CellsGenerationMethod.shakemap_gridxml_h3_grid_point_p90_v1
    ) {
        throw new Error(`cells_generation_method has unknown value: ${cellsGenerationMethod}`);
    }

    return {
        event_uid: expectPrefixedHex32("leaf.event_uid", record.event_uid),
        event_revision: expectNonNegativeSafeInteger(
            "leaf.event_revision",
            record.event_revision,
        ),
        h3_index: BigInt(expectDecimalU64String("leaf.h3_index", record.h3_index)),
        geo_resolution: expectNonNegativeSafeInteger(
            "leaf.geo_resolution",
            record.geo_resolution,
        ),
        cell_band: expectNonNegativeSafeInteger("leaf.cell_band", record.cell_band),
        intensity_value: expectNonNegativeSafeInteger(
            "leaf.intensity_value",
            record.intensity_value,
        ),
        cell_metric: cellMetric,
        intensity_scale: intensityScale,
        cells_generation_method: cellsGenerationMethod,
        oracle_version: BigInt(
            expectDecimalU64String("leaf.oracle_version", record.oracle_version),
        ),
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

async function verifyAffectedCellsProof(proof: AffectedCellsProof): Promise<void> {
    const leafHash = await affectedCellLeafHash(proof.leaf);
    const replayedRoot = await replayProof(leafHash, proof.proof);
    if (replayedRoot !== proof.affected_cells_root) {
        throw new ClaimProofError(
            "proof_verification_failed",
            "Affected cells proof does not replay to the expected root.",
        );
    }
}

function expectDecimalU64String(name: string, value: unknown): string {
    const text = expectString(name, value);
    if (!/^(0|[1-9]\d*)$/u.test(text)) {
        throw new Error(`${name} must be a decimal u64 string`);
    }
    const parsed = BigInt(text);
    if (parsed > U64_MAX) {
        throw new Error(`${name} must fit in u64`);
    }
    return text;
}
