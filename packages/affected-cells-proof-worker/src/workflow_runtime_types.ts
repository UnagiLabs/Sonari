export {};

declare global {
    interface WorkflowEntrypoint<Env = unknown, Params = unknown> {
        readonly env: Env;
        run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown>;
    }

    interface WorkflowEvent<T = unknown> {
        readonly payload: Readonly<T>;
        readonly timestamp: Date;
        readonly instanceId: string;
        readonly workflowName: string;
    }

    interface WorkflowStepConfig {
        readonly retries?: {
            readonly limit: number;
            readonly delay: string | number;
            readonly backoff?: "constant" | "linear" | "exponential";
        };
        readonly timeout?: string | number;
    }

    interface WorkflowStep {
        do<T>(
            name: string,
            config: WorkflowStepConfig,
            callback: () => Promise<T> | T,
        ): Promise<T>;
        do<T>(name: string, callback: () => Promise<T> | T): Promise<T>;
    }

    var WorkflowEntrypoint:
        | {
              new <Env = unknown, Params = unknown>(): WorkflowEntrypoint<Env, Params>;
          }
        | undefined;
    var NonRetryableError: (new (message?: string) => Error) | undefined;
}
