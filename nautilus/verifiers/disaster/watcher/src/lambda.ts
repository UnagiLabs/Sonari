import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import {
    createManualHandler,
    createScheduledHandler,
    DynamoDbStateRepository,
    type ManualLambdaEvent,
    type WorkflowStarter,
} from "./index.js";

const sfn = new SFNClient({});
const secrets = new SecretsManagerClient({});

class StepFunctionsWorkflowStarter implements WorkflowStarter {
    constructor(private readonly stateMachineArn: string) {}

    async start(input: {
        sourceEventId: string;
        executionName: string;
        attempt?: number;
    }): Promise<void> {
        await sfn.send(
            new StartExecutionCommand({
                stateMachineArn: this.stateMachineArn,
                name: input.executionName,
                input: JSON.stringify({
                    source_event_id: input.sourceEventId,
                    attempt: input.attempt ?? 1,
                }),
            }),
        );
    }
}

export async function scheduledHandler(): Promise<unknown> {
    return createScheduledHandler({
        repository: new DynamoDbStateRepository(requiredEnv("EVENTS_TABLE_NAME")),
        workflow: new StepFunctionsWorkflowStarter(requiredEnv("RUNNER_STATE_MACHINE_ARN")),
    })();
}

export async function manualHandler(event: ManualLambdaEvent): Promise<unknown> {
    const token = await manualToken();
    return createManualHandler({
        repository: new DynamoDbStateRepository(requiredEnv("EVENTS_TABLE_NAME")),
        workflow: new StepFunctionsWorkflowStarter(requiredEnv("RUNNER_STATE_MACHINE_ARN")),
        token,
    })(event);
}

async function manualToken(): Promise<string> {
    if (
        process.env.MANUAL_SUBMIT_TOKEN !== undefined &&
        process.env.MANUAL_SUBMIT_TOKEN.length > 0
    ) {
        return process.env.MANUAL_SUBMIT_TOKEN;
    }
    const secretId = requiredEnv("RUNNER_TOKEN_SECRET_ARN");
    const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (result.SecretString === undefined || result.SecretString.length === 0) {
        throw new Error(`${secretId} did not contain SecretString`);
    }
    return result.SecretString.trim();
}

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (value === undefined || value.length === 0) {
        throw new Error(`${name} is required`);
    }
    return value;
}
