declare module "cloudflare:workers" {
    export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
        readonly env: Env;
        run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown>;
    }
}

declare module "cloudflare:workflows" {
    export class NonRetryableError extends Error {}
}
