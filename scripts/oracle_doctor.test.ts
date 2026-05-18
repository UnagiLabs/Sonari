import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runOracleDoctor } from "./oracle_doctor.js";

describe("oracle doctor", () => {
    it("reports relayer, AWS runner, manual token, and migration consistency", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "sonari-doctor-test-"));
        try {
            const migrationsDir = path.join(dir, "migrations");
            await writeFile(path.join(dir, "schema.sql"), "CREATE TABLE earthquake_events;\n");
            await writeFile(path.join(dir, "schema.sql"), "CREATE TABLE earthquake_events;\n");

            const result = await runOracleDoctor({
                env: {
                    RELAYER_MODE: "dry_run",
                    RELAYER_ALLOW_SUBMIT: "false",
                    RELAYER_GRPC_URL: "https://fullnode.testnet.sui.io:443",
                    RELAYER_SENDER_ADDRESS: "0xabc",
                    AWS_RUNNER_BASE_URL: "https://runner.example",
                    AWS_RUNNER_TOKEN: "runner-token",
                    MANUAL_SUBMIT_TOKEN: "manual-token",
                },
                migrationsDir,
                schemaSqlPath: path.join(dir, "schema.sql"),
            });

            expect(result.ok).toBe(false);
            expect(result.checks).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ name: "RELAYER_MODE", status: "ok" }),
                    expect.objectContaining({ name: "RELAYER_ALLOW_SUBMIT", status: "warn" }),
                    expect.objectContaining({ name: "AWS_RUNNER_TOKEN", status: "ok" }),
                    expect.objectContaining({ name: "MANUAL_SUBMIT_TOKEN", status: "ok" }),
                    expect.objectContaining({ name: "D1_MIGRATIONS", status: "fail" }),
                ]),
            );
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
