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
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";

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

export interface ClaimProofContext {
    readonly eventUid: string;
    readonly eventRevision: number;
    readonly homeCell: string;
    readonly affectedCellsRoot: string;
}

export interface AffectedCellLeafMoveArgs {
    readonly eventUidBytes: number[];
    readonly eventRevision: number;
    readonly h3Index: string;
    readonly geoResolution: number;
    readonly cellMetric: number;
    readonly intensityValue: number;
    readonly intensityScale: number;
    readonly cellBand: number;
    readonly cellsGenerationMethod: number;
    readonly oracleVersion: string;
}

export interface AffectedCellProofMoveArg {
    readonly constructor:
        | "new_affected_cell_proof_step_left"
        | "new_affected_cell_proof_step_right";
    readonly siblingHashBytes: number[];
}

export interface ClaimTransactionObjectConfig {
    readonly pauseState: string;
    readonly membershipRegistry: string;
    readonly campaign: string;
    readonly disasterEvent: string;
    readonly identityRegistry: string;
    readonly pass: string;
    readonly clock?: string | undefined;
}

export interface BuildClaimFloorTransactionInput {
    readonly senderAddress?: string | undefined;
    readonly packageId: string;
    readonly objects: ClaimTransactionObjectConfig;
    readonly identityProvider: number;
    readonly duplicateKeyHash: string;
}

export interface BuildSubmitClaimV2TransactionInput {
    readonly senderAddress?: string | undefined;
    readonly packageId: string;
    readonly proof: AffectedCellsProof;
    readonly context: ClaimProofContext;
    readonly objects: ClaimTransactionObjectConfig;
}

export interface BuildVerifyClaimV2TransactionInput {
    readonly senderAddress?: string | undefined;
    readonly packageId: string;
    readonly objects: ClaimTransactionObjectConfig;
    readonly identityProvider: number;
    readonly duplicateKeyHash: string;
}

export interface BuildClaimPayoutTransactionInput {
    readonly senderAddress?: string | undefined;
    readonly packageId: string;
    readonly objects: ClaimTransactionObjectConfig;
}

export interface ClaimTransactionResult {
    readonly transaction: Transaction;
}

export interface SubmitClaimV2TransactionResult {
    readonly transaction: Transaction;
    readonly leafArgs: AffectedCellLeafMoveArgs;
    readonly proofArgs: AffectedCellProofMoveArg[];
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

export function assertProofMatchesClaimContext(
    proof: AffectedCellsProof,
    context: ClaimProofContext,
): void {
    if (proof.event_uid !== context.eventUid) {
        throw new ClaimProofError("invalid_proof_response", "event_uid does not match.");
    }
    if (proof.leaf.event_uid !== context.eventUid) {
        throw new ClaimProofError("invalid_proof_response", "leaf event_uid does not match.");
    }
    if (proof.event_revision !== context.eventRevision) {
        throw new ClaimProofError(
            "invalid_proof_response",
            "event_revision does not match.",
        );
    }
    if (proof.leaf.event_revision !== context.eventRevision) {
        throw new ClaimProofError(
            "invalid_proof_response",
            "leaf event_revision does not match.",
        );
    }
    if (proof.h3_index !== context.homeCell) {
        throw new ClaimProofError("invalid_proof_response", "home_cell does not match h3_index.");
    }
    if (proof.leaf.h3_index.toString() !== context.homeCell) {
        throw new ClaimProofError(
            "invalid_proof_response",
            "home_cell does not match leaf h3_index.",
        );
    }
    if (proof.affected_cells_root !== context.affectedCellsRoot) {
        throw new ClaimProofError(
            "invalid_proof_response",
            "affected_cells_root does not match.",
        );
    }
}

export function buildAffectedCellLeafMoveArgs(
    leaf: AffectedCellLeaf,
): AffectedCellLeafMoveArgs {
    return {
        eventUidBytes: hexToByteArray(leaf.event_uid),
        eventRevision: leaf.event_revision,
        h3Index: leaf.h3_index.toString(),
        geoResolution: leaf.geo_resolution,
        cellMetric: cellMetricToMoveValue(leaf.cell_metric),
        intensityValue: leaf.intensity_value,
        intensityScale: intensityScaleToMoveValue(leaf.intensity_scale),
        cellBand: leaf.cell_band,
        cellsGenerationMethod: cellsGenerationMethodToMoveValue(
            leaf.cells_generation_method,
        ),
        oracleVersion: leaf.oracle_version.toString(),
    };
}

export function buildAffectedCellProofMoveArgs(
    proof: readonly ProofStep[],
): AffectedCellProofMoveArg[] {
    return proof.map((step) => ({
        constructor: step.sibling_on_left
            ? "new_affected_cell_proof_step_left"
            : "new_affected_cell_proof_step_right",
        siblingHashBytes: hexToByteArray(step.sibling_hash),
    }));
}

export function buildClaimFloorTransaction(
    input: BuildClaimFloorTransactionInput,
): ClaimTransactionResult {
    const tx = newClaimTransaction(input.senderAddress);

    tx.moveCall({
        target: `${input.packageId}::accessor::claim_floor`,
        arguments: [
            tx.object(input.objects.pauseState),
            tx.object(input.objects.campaign),
            tx.object(input.objects.identityRegistry),
            tx.object(input.objects.membershipRegistry),
            tx.object(input.objects.pass),
            tx.pure.u8(input.identityProvider),
            duplicateKeyHashArg(tx, input.duplicateKeyHash),
            tx.object(input.objects.clock ?? SUI_CLOCK_OBJECT_ID),
        ],
    });

    return { transaction: tx };
}

export function buildSubmitClaimV2Transaction(
    input: BuildSubmitClaimV2TransactionInput,
): SubmitClaimV2TransactionResult {
    assertProofMatchesClaimContext(input.proof, input.context);

    const tx = newClaimTransaction(input.senderAddress);
    const { leaf, leafArgs, proof, proofArgs } = buildAffectedCellMoveInputs(
        tx,
        input.packageId,
        input.proof,
    );

    tx.moveCall({
        target: `${input.packageId}::accessor::submit_claim_v2`,
        arguments: [
            tx.object(input.objects.pauseState),
            tx.object(input.objects.campaign),
            tx.object(input.objects.disasterEvent),
            tx.object(input.objects.membershipRegistry),
            tx.object(input.objects.pass),
            leaf,
            proof,
            tx.object(input.objects.clock ?? SUI_CLOCK_OBJECT_ID),
        ],
    });

    return { transaction: tx, leafArgs, proofArgs };
}

export function buildVerifyClaimV2Transaction(
    input: BuildVerifyClaimV2TransactionInput,
): ClaimTransactionResult {
    const tx = newClaimTransaction(input.senderAddress);

    tx.moveCall({
        target: `${input.packageId}::accessor::verify_claim_v2`,
        arguments: [
            tx.object(input.objects.pauseState),
            tx.object(input.objects.campaign),
            tx.object(input.objects.identityRegistry),
            tx.object(input.objects.membershipRegistry),
            tx.object(input.objects.pass),
            tx.pure.u8(input.identityProvider),
            duplicateKeyHashArg(tx, input.duplicateKeyHash),
            tx.object(input.objects.clock ?? SUI_CLOCK_OBJECT_ID),
        ],
    });

    return { transaction: tx };
}

export function buildClaimPayoutTransaction(
    input: BuildClaimPayoutTransactionInput,
): ClaimTransactionResult {
    const tx = newClaimTransaction(input.senderAddress);

    tx.moveCall({
        target: `${input.packageId}::accessor::claim_payout`,
        arguments: [
            tx.object(input.objects.pauseState),
            tx.object(input.objects.campaign),
            tx.object(input.objects.membershipRegistry),
            tx.object(input.objects.pass),
            tx.object(input.objects.clock ?? SUI_CLOCK_OBJECT_ID),
        ],
    });

    return { transaction: tx };
}

function newClaimTransaction(senderAddress: string | undefined): Transaction {
    const tx = new Transaction();
    if (senderAddress !== undefined) {
        tx.setSender(senderAddress);
    }
    return tx;
}

function buildAffectedCellMoveInputs(
    tx: Transaction,
    packageId: string,
    proof: AffectedCellsProof,
) {
    const leafArgs = buildAffectedCellLeafMoveArgs(proof.leaf);
    const leaf = tx.moveCall({
        target: `${packageId}::accessor::new_affected_cell_leaf`,
        arguments: [
            tx.pure.vector("u8", leafArgs.eventUidBytes),
            tx.pure.u32(leafArgs.eventRevision),
            tx.pure.u64(leafArgs.h3Index),
            tx.pure.u8(leafArgs.geoResolution),
            tx.pure.u8(leafArgs.cellMetric),
            tx.pure.u16(leafArgs.intensityValue),
            tx.pure.u8(leafArgs.intensityScale),
            tx.pure.u8(leafArgs.cellBand),
            tx.pure.u8(leafArgs.cellsGenerationMethod),
            tx.pure.u64(leafArgs.oracleVersion),
        ],
    });

    const proofArgs = buildAffectedCellProofMoveArgs(proof.proof);
    const proofSteps = proofArgs.map((step) =>
        tx.moveCall({
            target: `${packageId}::accessor::${step.constructor}`,
            arguments: [tx.pure.vector("u8", step.siblingHashBytes)],
        }),
    );
    const proofVector = tx.makeMoveVec({
        type: `${packageId}::affected_cell::ProofStep`,
        elements: proofSteps,
    });

    return { leaf, leafArgs, proof: proofVector, proofArgs };
}

function duplicateKeyHashArg(tx: Transaction, duplicateKeyHash: string) {
    return tx.pure.vector(
        "u8",
        hexToByteArray(expectPrefixedHex32("duplicate_key_hash", duplicateKeyHash)),
    );
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

function hexToByteArray(value: PrefixedHex32): number[] {
    const bytes: number[] = [];
    for (let index = 2; index < value.length; index += 2) {
        bytes.push(Number.parseInt(value.slice(index, index + 2), 16));
    }
    return bytes;
}

function cellMetricToMoveValue(value: AffectedCellLeaf["cell_metric"]): number {
    if (value === CellMetric.USGS_MMI) {
        return 1;
    }
    throw new ClaimProofError("invalid_proof_response", `Unknown cell_metric: ${value}`);
}

function intensityScaleToMoveValue(value: AffectedCellLeaf["intensity_scale"]): number {
    if (value === IntensityScale.MMI_X100) {
        return 1;
    }
    throw new ClaimProofError("invalid_proof_response", `Unknown intensity_scale: ${value}`);
}

function cellsGenerationMethodToMoveValue(
    value: AffectedCellLeaf["cells_generation_method"],
): number {
    if (value === CellsGenerationMethod.shakemap_gridxml_h3_grid_point_p90_v1) {
        return 1;
    }
    throw new ClaimProofError(
        "invalid_proof_response",
        `Unknown cells_generation_method: ${value}`,
    );
}
