import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

describe("AWS Lambda entrypoints", () => {
    afterEach(() => {
        process.env = { ...originalEnv };
        vi.resetModules();
        vi.restoreAllMocks();
        vi.doUnmock("@aws-sdk/client-secrets-manager");
        vi.doUnmock("@aws-sdk/client-sfn");
    });

    it("caches the manual auth secret across unauthorized warm invocations", async () => {
        const secretReads: unknown[] = [];
        vi.doMock("@aws-sdk/client-secrets-manager", () => ({
            GetSecretValueCommand: class {
                constructor(readonly input: unknown) {}
            },
            SecretsManagerClient: class {
                async send(command: unknown): Promise<{ SecretString: string }> {
                    secretReads.push(command);
                    return { SecretString: "manual-token" };
                }
            },
        }));
        vi.doMock("@aws-sdk/client-sfn", () => ({
            StartExecutionCommand: class {
                constructor(readonly input: unknown) {}
            },
            SFNClient: class {
                async send(): Promise<void> {}
            },
        }));
        delete process.env.MANUAL_SUBMIT_TOKEN;
        process.env.RUNNER_TOKEN_SECRET_ARN = "arn:aws:secretsmanager:runner-token";
        process.env.EVENTS_TABLE_NAME = "events";
        process.env.RUNNER_STATE_MACHINE_ARN = "arn:aws:states:runner";
        process.env.RELAYER_TARGET =
            "0x1234::accessor::create_disaster_event_and_campaign_from_signed_payload";
        process.env.SONARI_SUI_GRAPHQL_URL = "https://graphql.testnet.sui.io/graphql";
        const { manualHandler } = await import("../src/lambda.js");

        await expect(
            manualHandler({
                headers: { authorization: "Bearer wrong" },
                body: JSON.stringify({ source_event_id: "us7000manual" }),
            }),
        ).resolves.toMatchObject({ statusCode: 401 });
        await expect(
            manualHandler({
                headers: { authorization: "Bearer still-wrong" },
                body: JSON.stringify({ source_event_id: "us7000manual" }),
            }),
        ).resolves.toMatchObject({ statusCode: 401 });

        expect(secretReads).toHaveLength(1);
    });
});
