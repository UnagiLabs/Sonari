export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    readonly env!: Env;

    async run(_event: WorkflowEvent<Params>, _step: WorkflowStep): Promise<unknown> {
        throw new Error("WorkflowEntrypoint is unavailable outside the Cloudflare runtime");
    }
}

export class NonRetryableError extends Error {}
