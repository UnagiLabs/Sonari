import {
    expectNonNegativeSafeInteger,
    expectPositiveSafeInteger,
    expectPrefixedHex32,
    expectRecord,
    expectString,
} from "@sonari/proof-core";

export interface AffectedAreaWorkflowInput {
    readonly event_uid: string;
    readonly event_revision: number;
    readonly affected_cells_hash: string;
    readonly affected_cells_root: string;
    readonly affected_cell_count: number;
    readonly geo_resolution: 7;
    readonly affected_cells_uri: string;
}

export interface AffectedAreaWorkflowSummary {
    readonly event_uid: string;
    readonly event_revision: number;
    readonly affected_cells_root: string;
}

function expectWalrusBlobUri(name: string, value: unknown): string {
    const uri = expectString(name, value);
    if (!/^walrus:\/\/blob\/[^/]+$/u.test(uri)) {
        throw new Error(`${name} must be a walrus://blob/<blob-id> URI`);
    }
    return uri;
}

export function validateAffectedAreaWorkflowInput(input: unknown): AffectedAreaWorkflowInput {
    const record = expectRecord("affected-area workflow input", input);
    const geoResolution = expectNonNegativeSafeInteger("geo_resolution", record.geo_resolution);
    if (geoResolution !== 7) {
        throw new Error(`geo_resolution must be 7, got ${geoResolution}`);
    }

    return {
        event_uid: expectPrefixedHex32("event_uid", record.event_uid),
        event_revision: expectPositiveSafeInteger("event_revision", record.event_revision),
        affected_cells_hash: expectPrefixedHex32(
            "affected_cells_hash",
            record.affected_cells_hash,
        ),
        affected_cells_root: expectPrefixedHex32(
            "affected_cells_root",
            record.affected_cells_root,
        ),
        affected_cell_count: expectPositiveSafeInteger(
            "affected_cell_count",
            record.affected_cell_count,
        ),
        geo_resolution: 7,
        affected_cells_uri: expectWalrusBlobUri("affected_cells_uri", record.affected_cells_uri),
    };
}

export function summarizeAffectedAreaWorkflowInput(
    input: AffectedAreaWorkflowInput,
): AffectedAreaWorkflowSummary {
    return {
        event_uid: input.event_uid,
        event_revision: input.event_revision,
        affected_cells_root: input.affected_cells_root,
    };
}
