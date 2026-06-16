export {};

declare global {
    class WorkflowEntrypoint<Env = unknown, Params = unknown> {
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

    interface WorkflowInstanceCreateOptions<Params = unknown> {
        readonly id?: string;
        readonly params?: Params;
    }

    type InstanceStatus = {
        readonly status:
            | "queued"
            | "running"
            | "paused"
            | "errored"
            | "terminated"
            | "complete"
            | "waiting"
            | "waitingForPause"
            | "unknown";
        readonly error?: {
            readonly name: string;
            readonly message: string;
        };
        readonly output?: unknown;
        readonly rollback:
            | {
                  readonly outcome: "complete" | "failed";
                  readonly error: {
                      readonly name: string;
                      readonly message: string;
                  } | null;
              }
            | null;
    };

    interface WorkflowInstance {
        readonly id: string;
        status(): Promise<InstanceStatus>;
        restart(): Promise<void>;
    }

    interface Workflow<Params = unknown> {
        createBatch(
            batch: readonly WorkflowInstanceCreateOptions<Params>[],
        ): Promise<WorkflowInstance[]>;
        get(id: string): Promise<WorkflowInstance>;
    }

    var NonRetryableError: (new (message?: string) => Error) | undefined;
}
