import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runOracleDoctor } from "./oracle_doctor.js";

describe("oracle doctor", () => {
    it("reports relayer and AWS-only orchestration configuration", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "sonari-doctor-test-"));
        try {
            const templatePath = path.join(dir, "template.yaml");
            await writeFile(
                templatePath,
                [
                    "Type: AWS::DynamoDB::Table",
                    "Type: AWS::S3::Bucket",
                    "Type: AWS::Lambda::Function",
                    "Type: AWS::StepFunctions::StateMachine",
                    "Type: AWS::Scheduler::Schedule",
                ].join("\n"),
            );

            const result = await runOracleDoctor({
                env: {
                    RELAYER_MODE: "dry_run",
                    RELAYER_NETWORK: "testnet",
                    RELAYER_ALLOW_SUBMIT: "false",
                    RELAYER_TARGET: "0xtarget",
                    RELAYER_REGISTRY: "0xregistry",
                    RELAYER_VERIFIER_REGISTRY: "0xverifier",
                    RELAYER_CATEGORY_REGISTRY: "0xcategoryregistry",
                    RELAYER_CATEGORY_POOL: "0xcategorypool",
                    RELAYER_GRPC_URL: "https://fullnode.testnet.sui.io:443",
                    RELAYER_SENDER_ADDRESS: "0xabc",
                    RUNNER_TOKEN_SECRET_ARN: "arn:aws:secretsmanager:runner-token",
                    EVENTS_TABLE_NAME: "events",
                    RUNNER_STATE_MACHINE_ARN: "arn:aws:states:runner",
                    RESULT_BUCKET: "results",
                    RUNNER_ASG_NAME: "runner-asg",
                    NITRO_ENCLAVE_PROCESS_COMMAND: "/opt/sonari/bin/run-enclave",
                    MANUAL_SUBMIT_TOKEN: "manual-token",
                },
                templatePath,
            });

            expect(result.ok).toBe(true);
            expect(result.checks).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ name: "RELAYER_MODE", status: "ok" }),
                    expect.objectContaining({ name: "RELAYER_TARGET", status: "ok" }),
                    expect.objectContaining({ name: "RELAYER_REGISTRY", status: "ok" }),
                    expect.objectContaining({ name: "RELAYER_VERIFIER_REGISTRY", status: "ok" }),
                    expect.objectContaining({ name: "RELAYER_CATEGORY_REGISTRY", status: "ok" }),
                    expect.objectContaining({ name: "RELAYER_CATEGORY_POOL", status: "ok" }),
                    expect.objectContaining({ name: "RELAYER_NETWORK", status: "ok" }),
                    expect.objectContaining({ name: "RELAYER_ALLOW_SUBMIT", status: "warn" }),
                    expect.objectContaining({ name: "RUNNER_TOKEN_SECRET_ARN", status: "ok" }),
                    expect.objectContaining({ name: "EVENTS_TABLE_NAME", status: "ok" }),
                    expect.objectContaining({ name: "AWS_ONLY_TEMPLATE", status: "ok" }),
                ]),
            );
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("fails closed for invalid relayer network and submit guard configuration", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "sonari-doctor-test-"));
        try {
            const templatePath = path.join(dir, "template.yaml");
            await writeFile(
                templatePath,
                [
                    "Type: AWS::DynamoDB::Table",
                    "Type: AWS::S3::Bucket",
                    "Type: AWS::Lambda::Function",
                    "Type: AWS::StepFunctions::StateMachine",
                    "Type: AWS::Scheduler::Schedule",
                ].join("\n"),
            );

            const result = await runOracleDoctor({
                env: {
                    RELAYER_MODE: "submit",
                    RELAYER_NETWORK: "testnet",
                    RELAYER_ALLOW_SUBMIT: "false",
                    RELAYER_GRPC_URL: "https://fullnode.mainnet.sui.io:443",
                },
                templatePath,
            });

            expect(result.ok).toBe(false);
            expect(result.checks).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        name: "RELAYER_GRPC_URL",
                        status: "fail",
                    }),
                    expect.objectContaining({
                        name: "RELAYER_SUBMIT_GUARD",
                        status: "fail",
                    }),
                    expect.objectContaining({
                        name: "RELAYER_TARGET",
                        status: "fail",
                    }),
                    expect.objectContaining({
                        name: "RELAYER_REGISTRY",
                        status: "fail",
                    }),
                    expect.objectContaining({
                        name: "RELAYER_VERIFIER_REGISTRY",
                        status: "fail",
                    }),
                    expect.objectContaining({
                        name: "RELAYER_CATEGORY_REGISTRY",
                        status: "fail",
                    }),
                    expect.objectContaining({
                        name: "RELAYER_CATEGORY_POOL",
                        status: "fail",
                    }),
                ]),
            );
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("fails when the template still exposes the legacy ALB runner", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "sonari-doctor-test-"));
        try {
            const templatePath = path.join(dir, "template.yaml");
            await writeFile(
                templatePath,
                [
                    "Type: AWS::DynamoDB::Table",
                    "Type: AWS::S3::Bucket",
                    "Type: AWS::Lambda::Function",
                    "Type: AWS::StepFunctions::StateMachine",
                    "Type: AWS::Scheduler::Schedule",
                    "Type: AWS::ElasticLoadBalancingV2::LoadBalancer",
                ].join("\n"),
            );

            const result = await runOracleDoctor({ env: {}, templatePath });

            expect(result.checks).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        name: "AWS_ONLY_TEMPLATE",
                        status: "fail",
                    }),
                ]),
            );
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
