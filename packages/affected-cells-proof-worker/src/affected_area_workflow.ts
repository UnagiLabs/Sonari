import "./workflow_runtime_types.js";
import { sha256Hex } from "@sonari/proof-core";
import { NonRetryableError } from "cloudflare:workflows";
import { generateAffectedAreaArtifacts } from "./affected_area_artifacts.js";
import {
    affectedAreaManifestR2Key,
    type AffectedAreaR2Bucket,
    publishAffectedAreaArtifacts,
} from "./affected_area_r2.js";
import {
    summarizeAffectedAreaWorkflowInput,
    type AffectedAreaWorkflowInput,
    type AffectedAreaWorkflowSummary,
} from "./affected_area_workflow_input.js";
import { fetchWalrusBlob } from "./walrus.js";

export interface AffectedAreaWorkflowEnv {
    readonly AFFECTED_AREA_ARTIFACTS?: AffectedAreaR2Bucket;
    readonly WALRUS_AGGREGATOR_URL?: string;
    readonly SONARI_AFFECTED_AREA_BASE_URL?: string;
}

export interface AffectedAreaWorkflowPublishSummary extends AffectedAreaWorkflowSummary {
    readonly object_count: number;
    readonly manifest_r2_key: string;
}

function nonRetryableWorkflowError(cause: unknown): Error {
    const message = cause instanceof Error ? cause.message : String(cause);
    return new NonRetryableError(message);
}

function requireAffectedAreaBucket(env: AffectedAreaWorkflowEnv): AffectedAreaR2Bucket {
    const bucket = env.AFFECTED_AREA_ARTIFACTS;
    if (bucket === undefined) {
        throw nonRetryableWorkflowError(new Error("AFFECTED_AREA_ARTIFACTS is not configured"));
    }
    return bucket;
}

function requireAffectedAreaBaseUrl(env: AffectedAreaWorkflowEnv): string {
    const baseUrl = env.SONARI_AFFECTED_AREA_BASE_URL?.trim();
    if (baseUrl === undefined || baseUrl.length === 0) {
        throw nonRetryableWorkflowError(
            new Error("SONARI_AFFECTED_AREA_BASE_URL is not configured"),
        );
    }
    return baseUrl;
}

export async function runAffectedAreaArtifactWorkflow(
    input: AffectedAreaWorkflowInput,
    env: AffectedAreaWorkflowEnv,
    fetchImpl: typeof fetch = fetch,
): Promise<AffectedAreaWorkflowPublishSummary> {
    const bucket = requireAffectedAreaBucket(env);
    const baseUrl = requireAffectedAreaBaseUrl(env);
    const rawBytes = await fetchWalrusBlob(input.affected_cells_uri, env, fetchImpl);
    const bytes = new Uint8Array(rawBytes);
    const computedHash = sha256Hex(bytes);
    if (computedHash !== input.affected_cells_hash) {
        throw nonRetryableWorkflowError(
            new Error(
                `affected_cells_hash mismatch: computed=${computedHash}, expected=${input.affected_cells_hash}`,
            ),
        );
    }

    let artifacts;
    try {
        artifacts = generateAffectedAreaArtifacts({
            bytes,
            affectedCellsRoot: input.affected_cells_root,
            baseUrl,
        });
    } catch (cause) {
        throw nonRetryableWorkflowError(cause);
    }

    const { objectKeys } = await publishAffectedAreaArtifacts({
        bucket,
        artifacts,
        eventRevision: input.event_revision,
    });

    return {
        ...summarizeAffectedAreaWorkflowInput(input),
        object_count: objectKeys.length,
        manifest_r2_key: affectedAreaManifestR2Key(input.event_uid, input.event_revision),
    };
}
