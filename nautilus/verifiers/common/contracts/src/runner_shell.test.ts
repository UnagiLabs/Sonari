import { describe, expect, it } from "vitest";
import {
    buildRequiredShellEnvCheck,
    buildRunnerBootstrapReadinessShellCommand,
    buildRunnerSsmShellCommand,
    parseNitroEnclaveProcessCommand,
    shellSingleQuote,
} from "./runner_shell.js";

describe("shell helpers", () => {
    it("builds required env checks in the same fail-closed shape", () => {
        expect(buildRequiredShellEnvCheck("SONARI_FOO")).toBe(
            ': "${SONARI_FOO:?SONARI_FOO is required}"',
        );
    });

    it("single-quotes shell values safely", () => {
        expect(shellSingleQuote("a'b c")).toBe("'a'\\''b c'");
    });

    it("parses valid Nitro command strings with quotes and escapes", () => {
        expect(parseNitroEnclaveProcessCommand(`/opt/bin/run 'hello world' foo\\ bar "baz qux"`)).toEqual([
            "/opt/bin/run",
            "hello world",
            "foo bar",
            "baz qux",
        ]);
    });

    it("fails closed on malformed Nitro command strings", () => {
        expect(() => parseNitroEnclaveProcessCommand("")).toThrow(/command is empty/);
        expect(() => parseNitroEnclaveProcessCommand("echo 'unterminated")).toThrow(
            /unterminated quote/,
        );
        expect(() => parseNitroEnclaveProcessCommand("echo \\")).toThrow(/trailing escape/);
    });

    it("builds the bootstrap readiness shell skeleton with domain-specific checks appended", () => {
        const command = buildRunnerBootstrapReadinessShellCommand({
            requiredEnvNames: ["SONARI_WALRUS_CLI", "SONARI_WALRUS_N_SHARDS"],
            postEnvCommands: [
                'test -x "$SONARI_WALRUS_CLI"',
                "systemctl is-active --quiet nitro-enclaves-allocator.service",
            ],
        });

        expect(command).toContain("set -euo pipefail");
        expect(command).toContain("test -f /opt/sonari/bootstrap-complete");
        expect(command).toContain("test -s /opt/sonari/runner.env");
        expect(command).toContain("source /opt/sonari/runner.env");
        expect(command).toContain(': "${SONARI_WALRUS_CLI:?SONARI_WALRUS_CLI is required}"');
        expect(command).toContain(': "${SONARI_WALRUS_N_SHARDS:?SONARI_WALRUS_N_SHARDS is required}"');
        expect(command).toContain('test -x "$SONARI_WALRUS_CLI"');
        expect(command.indexOf(': "${SONARI_WALRUS_N_SHARDS:?SONARI_WALRUS_N_SHARDS is required}"')).toBeLessThan(
            command.indexOf('test -x "$SONARI_WALRUS_CLI"'),
        );
        expect(command.indexOf('test -x "$SONARI_WALRUS_CLI"')).toBeLessThan(
            command.indexOf("systemctl is-active --quiet nitro-enclaves-allocator.service"),
        );
    });

    it("builds the SSM command skeleton with domain-specific exports and payload handling", () => {
        const command = buildRunnerSsmShellCommand({
            workflowId: "job-1",
            dispatchTimestampMs: 1_800_000_000_123,
            resultBucket: "runner-results",
            resultS3Key: "results/job-1/1800000000123.json",
            nitroEnclaveProcessCommand: "/opt/sonari/bin/run-membership-identity-enclave --flag",
            teeInput: { status: "verified" },
            preEnvCommands: [
                "systemctl is-active --quiet nitro-enclaves-allocator.service",
                "systemctl is-active --quiet sonari-earthquake-egress-vsock-proxy.service",
            ],
            requiredEnvNames: ["SONARI_MEMBERSHIP_IDENTITY_EIF_PATH"],
            postEnvCommands: ['test -s "$SONARI_MEMBERSHIP_IDENTITY_EIF_PATH"'],
            exportLines: [
                "export SONARI_MEMBERSHIP_IDENTITY_EIF_PATH SONARI_VERIFIER_KIND=membership_identity",
            ],
            tempResultPathPrefix: "/tmp/sonari-membership-tee-result",
        });

        expect(command).toContain("set -euo pipefail");
        expect(command).toContain("source /opt/sonari/runner.env");
        expect(command).toContain("systemctl is-active --quiet nitro-enclaves-allocator.service");
        expect(command).toContain("systemctl is-active --quiet sonari-earthquake-egress-vsock-proxy.service");
        expect(command).toContain(
            ': "${SONARI_MEMBERSHIP_IDENTITY_EIF_PATH:?SONARI_MEMBERSHIP_IDENTITY_EIF_PATH is required}"',
        );
        expect(command).toContain("export SONARI_MEMBERSHIP_IDENTITY_EIF_PATH SONARI_VERIFIER_KIND=membership_identity");
        expect(command).toContain('test -s "$SONARI_MEMBERSHIP_IDENTITY_EIF_PATH"');
        expect(command).toContain("RESULT_S3_KEY='results/job-1/1800000000123.json'");
        expect(command).toContain(
            "NITRO_ENCLAVE_PROCESS_COMMAND='/opt/sonari/bin/run-membership-identity-enclave --flag'",
        );
        expect(command).toContain("export NITRO_ENCLAVE_PROCESS_COMMAND");
        expect(command).toContain(
            `printf '%s' ${shellSingleQuote(JSON.stringify({ status: "verified" }))}`,
        );
        expect(command).toContain(
            "aws s3 cp '/tmp/sonari-membership-tee-result-job-1-1800000000123.json' 's3://runner-results/results/job-1/1800000000123.json'",
        );
        expect(command.indexOf("systemctl is-active --quiet nitro-enclaves-allocator.service")).toBeLessThan(
            command.indexOf(': "${SONARI_MEMBERSHIP_IDENTITY_EIF_PATH:?SONARI_MEMBERSHIP_IDENTITY_EIF_PATH is required}"'),
        );
        expect(command.indexOf("systemctl is-active --quiet sonari-earthquake-egress-vsock-proxy.service")).toBeLessThan(
            command.indexOf(': "${SONARI_MEMBERSHIP_IDENTITY_EIF_PATH:?SONARI_MEMBERSHIP_IDENTITY_EIF_PATH is required}"'),
        );
        expect(command.indexOf(': "${SONARI_MEMBERSHIP_IDENTITY_EIF_PATH:?SONARI_MEMBERSHIP_IDENTITY_EIF_PATH is required}"')).toBeLessThan(
            command.indexOf('test -s "$SONARI_MEMBERSHIP_IDENTITY_EIF_PATH"'),
        );
        expect(command.indexOf('test -s "$SONARI_MEMBERSHIP_IDENTITY_EIF_PATH"')).toBeLessThan(
            command.indexOf("export SONARI_MEMBERSHIP_IDENTITY_EIF_PATH SONARI_VERIFIER_KIND=membership_identity"),
        );
    });
});
