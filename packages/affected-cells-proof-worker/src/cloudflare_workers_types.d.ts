declare module "cloudflare:workers" {
    export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
        readonly env: Env;
        run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown>;
    }

    export class NonRetryableError extends Error {}
}
