import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SFNClient } from "@aws-sdk/client-sfn";
import {
    createManualHandler,
    createScheduledHandler,
    DynamoDbStateRepository,
    getLatestOnchainEventRevision,
    type ManualLambdaEvent,
    type OnchainEventRevisionReader,
    StepFunctionsWorkflowStarter,
} from "./index.js";

const sfn = new SFNClient({});
const secrets = new SecretsManagerClient({});
let cachedManualToken: string | undefined;

export async function scheduledHandler(): Promise<unknown> {
    return createScheduledHandler({
        repository: new DynamoDbStateRepository(requiredEnv("EVENTS_TABLE_NAME")),
        workflow: new StepFunctionsWorkflowStarter(requiredEnv("RUNNER_STATE_MACHINE_ARN"), sfn),
        readLatestOnchainEventRevision: readLatestOnchainEventRevisionFromEnv(),
    })();
}

export async function manualHandler(event: ManualLambdaEvent): Promise<unknown> {
    const token = await manualToken();
    return createManualHandler({
        repository: new DynamoDbStateRepository(requiredEnv("EVENTS_TABLE_NAME")),
        workflow: new StepFunctionsWorkflowStarter(requiredEnv("RUNNER_STATE_MACHINE_ARN"), sfn),
        token,
        readLatestOnchainEventRevision: readLatestOnchainEventRevisionFromEnv(),
    })(event);
}

function readLatestOnchainEventRevisionFromEnv(): OnchainEventRevisionReader {
    const graphqlUrl = requiredEnv("SONARI_SUI_GRAPHQL_URL");
    return {
        async readLatestEventRevision(eventUid: string): Promise<number> {
            const result = await getLatestOnchainEventRevision({
                eventUid,
                graphql: {
                    async query(query, variables) {
                        const response = await fetch(graphqlUrl, {
                            method: "POST",
                            headers: {
                                "content-type": "application/json",
                            },
                            body: JSON.stringify({ query, variables }),
                        });
                        if (!response.ok) {
                            throw new Error(
                                `Sui GraphQL query failed with HTTP ${response.status}`,
                            );
                        }
                        return response.json() as Promise<unknown>;
                    },
                },
            });
            return result.latestRevision;
        },
    };
}

async function manualToken(): Promise<string> {
    if (
        process.env.MANUAL_SUBMIT_TOKEN !== undefined &&
        process.env.MANUAL_SUBMIT_TOKEN.length > 0
    ) {
        return process.env.MANUAL_SUBMIT_TOKEN;
    }
    if (cachedManualToken !== undefined) {
        return cachedManualToken;
    }
    const secretId = requiredEnv("RUNNER_TOKEN_SECRET_ARN");
    const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
    const token = result.SecretString?.trim();
    if (token === undefined || token.length === 0) {
        throw new Error(`${secretId} did not contain SecretString`);
    }
    cachedManualToken = token;
    return token;
}

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (value === undefined || value.length === 0) {
        throw new Error(`${name} is required`);
    }
    return value;
}
