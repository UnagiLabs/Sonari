import { describe, expect, it } from "vitest";
import {
    buildRunnerBootstrapReadinessShellCommand,
    buildRunnerSsmShellCommand,
} from "./runner_shell.js";

const WALRUS_CLI_REQUIRED = `: "\${SONARI_WALRUS_CLI:?SONARI_WALRUS_CLI is required}"`;
const WALRUS_N_SHARDS_REQUIRED = `: "\${SONARI_WALRUS_N_SHARDS:?SONARI_WALRUS_N_SHARDS is required}"`;
const MEMBERSHIP_IDENTITY_EIF_REQUIRED = `: "\${SONARI_MEMBERSHIP_IDENTITY_EIF_PATH:?SONARI_MEMBERSHIP_IDENTITY_EIF_PATH is required}"`;

describe("shell helpers", () => {
    it("builds the bootstrap readiness shell skeleton with domain-specific checks appended", () => {
        expect(
            buildRunnerBootstrapReadinessShellCommand({
                requiredEnvNames: ["SONARI_WALRUS_CLI", "SONARI_WALRUS_N_SHARDS"],
                postEnvCommands: [
                    'test -x "$SONARI_WALRUS_CLI"',
                    "systemctl is-active --quiet nitro-enclaves-allocator.service",
                ],
            }),
        ).toBe(
            [
                "set -euo pipefail",
                "test -f /opt/sonari/bootstrap-complete",
                "test -s /opt/sonari/runner.env",
                "source /opt/sonari/runner.env",
                WALRUS_CLI_REQUIRED,
                WALRUS_N_SHARDS_REQUIRED,
                'test -x "$SONARI_WALRUS_CLI"',
                "systemctl is-active --quiet nitro-enclaves-allocator.service",
            ].join("\n"),
        );
    });

    it("builds the SSM command skeleton with domain-specific exports and payload handling", () => {
        expect(
            buildRunnerSsmShellCommand({
                resultBucket: "runner-results",
                resultS3Key: "results/job-1/1800000000123.json",
                nitroEnclaveProcessCommand:
                    "/opt/sonari/bin/run-membership-identity-enclave --flag",
                teeInput: { status: "verified" },
                preEnvCommands: [
                    "systemctl is-active --quiet nitro-enclaves-allocator.service",
                    "systemctl is-active --quiet sonari-earthquake-egress-vsock-proxy.service",
                ],
                requiredEnvNames: ["SONARI_MEMBERSHIP_IDENTITY_EIF_PATH"],
                postEnvCommands: [
                    'test -s "$SONARI_MEMBERSHIP_IDENTITY_EIF_PATH"',
                    "export SONARI_MEMBERSHIP_IDENTITY_EIF_PATH SONARI_NITRO_RUN_ENCLAVE_ARGS SONARI_MEMBERSHIP_IDENTITY_ENCLAVE_CID SONARI_WORLD_ID_API_BASE SONARI_WORLD_ID_EGRESS_PROXY_URL SONARI_WORLD_ID_APP_ID NITRO_ENCLAVE_PROCESS_COMMAND",
                    "export SONARI_VERIFIER_KIND=membership_identity",
                ],
                tempResultPath: "/tmp/sonari-membership-tee-result-job-1-1800000000123.json",
            }),
        ).toBe(
            [
                "set -euo pipefail",
                "source /opt/sonari/runner.env",
                "systemctl is-active --quiet nitro-enclaves-allocator.service",
                "systemctl is-active --quiet sonari-earthquake-egress-vsock-proxy.service",
                MEMBERSHIP_IDENTITY_EIF_REQUIRED,
                'test -s "$SONARI_MEMBERSHIP_IDENTITY_EIF_PATH"',
                "export SONARI_MEMBERSHIP_IDENTITY_EIF_PATH SONARI_NITRO_RUN_ENCLAVE_ARGS SONARI_MEMBERSHIP_IDENTITY_ENCLAVE_CID SONARI_WORLD_ID_API_BASE SONARI_WORLD_ID_EGRESS_PROXY_URL SONARI_WORLD_ID_APP_ID NITRO_ENCLAVE_PROCESS_COMMAND",
                "export SONARI_VERIFIER_KIND=membership_identity",
                "RESULT_S3_KEY='results/job-1/1800000000123.json'",
                "NITRO_ENCLAVE_PROCESS_COMMAND='/opt/sonari/bin/run-membership-identity-enclave --flag'",
                "export NITRO_ENCLAVE_PROCESS_COMMAND",
                "printf '%s' '{\"status\":\"verified\"}' | '/opt/sonari/bin/run-membership-identity-enclave' '--flag' > '/tmp/sonari-membership-tee-result-job-1-1800000000123.json'",
                "aws s3 cp '/tmp/sonari-membership-tee-result-job-1-1800000000123.json' 's3://runner-results/results/job-1/1800000000123.json'",
            ].join("\n"),
        );
    });

    it("builds the SSM command skeleton with S3-staged payload handling", () => {
        expect(
            buildRunnerSsmShellCommand({
                resultBucket: "runner-results",
                resultS3Key: "results/job-1/1800000000123.json",
                nitroEnclaveProcessCommand: "/opt/sonari/bin/run-census-enclave --flag",
                teeInputS3Uri: "s3://runner-results/source-artifacts/job-1/input.json",
                tempResultPath: "/tmp/sonari-census-tee-result-job-1-1800000000123.json",
            }),
        ).toBe(
            [
                "set -euo pipefail",
                "source /opt/sonari/runner.env",
                "RESULT_S3_KEY='results/job-1/1800000000123.json'",
                "NITRO_ENCLAVE_PROCESS_COMMAND='/opt/sonari/bin/run-census-enclave --flag'",
                "export NITRO_ENCLAVE_PROCESS_COMMAND",
                "aws s3 cp 's3://runner-results/source-artifacts/job-1/input.json' - | '/opt/sonari/bin/run-census-enclave' '--flag' > '/tmp/sonari-census-tee-result-job-1-1800000000123.json'",
                "aws s3 cp '/tmp/sonari-census-tee-result-job-1-1800000000123.json' 's3://runner-results/results/job-1/1800000000123.json'",
            ].join("\n"),
        );
    });

    it("requires exactly one SSM payload source", () => {
        const base = {
            resultBucket: "runner-results",
            resultS3Key: "results/job-1/1800000000123.json",
            nitroEnclaveProcessCommand: "/opt/sonari/bin/run-census-enclave",
            tempResultPath: "/tmp/sonari-census-tee-result-job-1-1800000000123.json",
        };

        expect(() => buildRunnerSsmShellCommand(base)).toThrow(
            "exactly one of teeInput or teeInputS3Uri is required",
        );
        expect(() =>
            buildRunnerSsmShellCommand({
                ...base,
                teeInput: { status: "verified" },
                teeInputS3Uri: "s3://runner-results/source-artifacts/job-1/input.json",
            }),
        ).toThrow("exactly one of teeInput or teeInputS3Uri is required");
    });

    it.each([
        ["", /command is empty/],
        ["echo 'unterminated", /unterminated quote/],
        ["echo \\", /trailing escape/],
    ])("fails closed on malformed Nitro command string %j", (nitroCommand, expectedError) => {
        expect(() =>
            buildRunnerSsmShellCommand({
                resultBucket: "runner-results",
                resultS3Key: "results/job-1/1800000000123.json",
                nitroEnclaveProcessCommand: nitroCommand,
                teeInput: { status: "verified" },
                tempResultPath: "/tmp/sonari-membership-tee-result-job-1-1800000000123.json",
            }),
        ).toThrow(expectedError);
    });
});
