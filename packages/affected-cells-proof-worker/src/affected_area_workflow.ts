import "./workflow_runtime_types.js";
import { sha256Hex } from "@sonari/proof-core";
import { generateAffectedAreaArtifacts } from "./affected_area_artifacts.js";
import {
    affectedAreaManifestR2Key,
    type AffectedAreaR2Bucket,
    publishAffectedAreaArtifacts,
} from "./affected_area_r2.js";
import {
    summarizeAffectedAreaWorkflowInput,
    validateAffectedAreaWorkflowInput,
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

const PUBLISH_STEP_CONFIG: WorkflowStepConfig = {
    retries: {
        limit: 5,
        delay: "10 seconds",
        backoff: "exponential",
    },
    timeout: "5 minutes",
};

function nonRetryableWorkflowError(cause: unknown): Error {
    const message = cause instanceof Error ? cause.message : String(cause);
    const Constructor = globalThis.NonRetryableError;
    return typeof Constructor === "function" ? new Constructor(message) : new Error(message);
}

const workflowRuntime = globalThis as typeof globalThis & {
    WorkflowEntrypoint?: typeof WorkflowEntrypoint;
};

if (workflowRuntime.WorkflowEntrypoint === undefined) {
    workflowRuntime.WorkflowEntrypoint = class {
        readonly env!: unknown;

        async run(): Promise<unknown> {
            throw new Error("WorkflowEntrypoint is unavailable outside the Cloudflare runtime");
        }
    } as unknown as typeof WorkflowEntrypoint;
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

export class AffectedAreaArtifactWorkflow extends WorkflowEntrypoint<
    AffectedAreaWorkflowEnv,
    AffectedAreaWorkflowInput
> {
    async run(
        event: WorkflowEvent<AffectedAreaWorkflowInput>,
        step: WorkflowStep,
    ): Promise<AffectedAreaWorkflowPublishSummary> {
        let input: AffectedAreaWorkflowInput;
        try {
            input = validateAffectedAreaWorkflowInput(event.payload);
        } catch (cause) {
            throw nonRetryableWorkflowError(cause);
        }

        return step.do("publish affected-area artifacts", PUBLISH_STEP_CONFIG, () =>
            runAffectedAreaArtifactWorkflow(input, this.env),
        );
    }
}
