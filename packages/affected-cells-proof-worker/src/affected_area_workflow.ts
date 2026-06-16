import "./workflow_runtime_types.js";
import {
    summarizeAffectedAreaWorkflowInput,
    validateAffectedAreaWorkflowInput,
    type AffectedAreaWorkflowInput,
    type AffectedAreaWorkflowSummary,
} from "./affected_area_workflow_input.js";

export interface AffectedAreaWorkflowEnv {
    readonly AFFECTED_AREA_ARTIFACTS?: unknown;
    readonly WALRUS_AGGREGATOR_URL?: string;
    readonly SONARI_AFFECTED_AREA_BASE_URL?: string;
}

const VALIDATION_STEP_CONFIG: WorkflowStepConfig = {
    retries: {
        limit: 0,
        delay: "0 seconds",
    },
};

function nonRetryableWorkflowError(cause: unknown): Error {
    const message = cause instanceof Error ? cause.message : String(cause);
    const Constructor = globalThis.NonRetryableError;
    return typeof Constructor === "function" ? new Constructor(message) : new Error(message);
}

const WorkflowEntrypointBase =
    globalThis.WorkflowEntrypoint ??
    class {
        async run(): Promise<unknown> {
            throw new Error("WorkflowEntrypoint is unavailable outside the Cloudflare runtime");
        }
    };

export class AffectedAreaArtifactWorkflow extends WorkflowEntrypointBase {
    async run(
        event: WorkflowEvent<AffectedAreaWorkflowInput>,
        step: WorkflowStep,
    ): Promise<AffectedAreaWorkflowSummary> {
        let input: AffectedAreaWorkflowInput;
        try {
            input = validateAffectedAreaWorkflowInput(event.payload);
        } catch (cause) {
            throw nonRetryableWorkflowError(cause);
        }

        return step.do("validate affected-area workflow input", VALIDATION_STEP_CONFIG, () =>
            summarizeAffectedAreaWorkflowInput(input),
        );
    }
}
