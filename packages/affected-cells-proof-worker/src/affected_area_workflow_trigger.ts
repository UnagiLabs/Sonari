import "./workflow_runtime_types.js";
import type { AffectedAreaWorkflowInput } from "./affected_area_workflow_input.js";
import { affectedAreaManifestR2Key } from "./affected_area_r2.js";

export interface AffectedAreaR2ReadableObject {
    arrayBuffer(): Promise<ArrayBuffer>;
}

export interface AffectedAreaR2ReadableBucket {
    get(key: string): Promise<AffectedAreaR2ReadableObject | null>;
}

export type AffectedAreaWorkflowBinding = Workflow<AffectedAreaWorkflowInput>;

export type AffectedAreaWorkflowStartAction =
    | "manifest_exists"
    | "created"
    | "already_running"
    | "restarted";

export interface StartAffectedAreaWorkflowParams {
    readonly bucket: AffectedAreaR2ReadableBucket;
    readonly workflow: AffectedAreaWorkflowBinding;
    readonly input: AffectedAreaWorkflowInput;
}

export interface StartAffectedAreaWorkflowResult {
    readonly workflow_id: string;
    readonly action: AffectedAreaWorkflowStartAction;
}

export function affectedAreaWorkflowInstanceId(input: AffectedAreaWorkflowInput): string {
    return `affected-area-${input.event_uid.slice(2)}-${input.event_revision}-${input.affected_cells_root.slice(2)}`;
}

async function affectedAreaManifestExists(
    bucket: AffectedAreaR2ReadableBucket,
    input: AffectedAreaWorkflowInput,
): Promise<boolean> {
    const object = await bucket.get(
        affectedAreaManifestR2Key(input.event_uid, input.event_revision),
    );
    return object !== null;
}

function shouldRestart(status: InstanceStatus["status"]): boolean {
    return status === "errored" || status === "terminated";
}

export async function startAffectedAreaArtifactWorkflow(
    params: StartAffectedAreaWorkflowParams,
): Promise<StartAffectedAreaWorkflowResult> {
    const { bucket, input, workflow } = params;
    const workflowId = affectedAreaWorkflowInstanceId(input);

    if (await affectedAreaManifestExists(bucket, input)) {
        return { workflow_id: workflowId, action: "manifest_exists" };
    }

    const created = await workflow.createBatch([{ id: workflowId, params: input }]);
    if (created.length > 0) {
        return { workflow_id: workflowId, action: "created" };
    }

    const instance = await workflow.get(workflowId);
    const status = await instance.status();
    if (shouldRestart(status.status)) {
        await instance.restart();
        return { workflow_id: workflowId, action: "restarted" };
    }

    return { workflow_id: workflowId, action: "already_running" };
}
