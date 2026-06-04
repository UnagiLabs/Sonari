import { SFNClient } from "@aws-sdk/client-sfn";
import {
    createBatchVerifierHandler,
    createSubmitVerificationHandler,
    DynamoDbVerificationJobRepository,
    StepFunctionsWorkflowStarter,
    type SubmitVerificationLambdaEvent,
} from "./index.js";

const sfn = new SFNClient({});

export async function submitVerificationHandler(
    event: SubmitVerificationLambdaEvent,
): Promise<unknown> {
    return createSubmitVerificationHandler({
        repository: new DynamoDbVerificationJobRepository(
            requiredEnv("VERIFICATION_JOBS_TABLE_NAME"),
        ),
        expectedRegistryId: requiredEnv("SONARI_IDENTITY_REGISTRY_ID"),
    })(event);
}

export async function batchVerifierHandler(): Promise<unknown> {
    return createBatchVerifierHandler({
        repository: new DynamoDbVerificationJobRepository(
            requiredEnv("VERIFICATION_JOBS_TABLE_NAME"),
        ),
        workflow: new StepFunctionsWorkflowStarter(requiredEnv("RUNNER_STATE_MACHINE_ARN"), sfn),
    })();
}

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (value === undefined || value.length === 0) {
        throw new Error(`${name} is required`);
    }
    return value;
}
