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
    const disasterEventType = disasterEventTypeFromRelayerTarget(requiredEnv("RELAYER_TARGET"));
    return {
        async readLatestEventRevision(eventUid: string): Promise<number> {
            const result = await getLatestOnchainEventRevision({
                eventUid,
                disasterEventType,
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

function disasterEventTypeFromRelayerTarget(target: string): string {
    const [packageId, moduleName, functionName] = target.split("::");
    if (
        packageId === undefined ||
        !/^0x[0-9a-fA-F]+$/.test(packageId) ||
        moduleName !== "accessor" ||
        functionName !== "create_disaster_event_and_campaign_from_signed_payload"
    ) {
        throw new Error(
            "RELAYER_TARGET must be <PACKAGE_ID>::accessor::create_disaster_event_and_campaign_from_signed_payload",
        );
    }
    return `${packageId}::disaster_event::DisasterEventCreated`;
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
