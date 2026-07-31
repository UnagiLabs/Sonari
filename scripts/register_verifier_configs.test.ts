import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.join(process.cwd(), "scripts/register-verifier-configs.sh");
const hex = (byte: number) => byte.toString(16).padStart(2, "0").repeat(48);
const pcrs = {
    earthquake: [hex(1), hex(2), hex(3)],
    identity: [hex(4), hex(5), hex(6)],
    census: [hex(7), hex(8), hex(9)],
} as const;

async function runRegister(options: {
    scenario: string;
    registryJson?: unknown;
}): Promise<{ exitCode: number; stdout: string; stderr: string; calls: string[] }> {
    const dir = await mkdtemp(path.join(tmpdir(), "sonari-register-verifier-"));
    try {
        const binDir = path.join(dir, "bin");
        await mkdir(binDir, { recursive: true });
        const callsPath = path.join(dir, "calls.jsonl");
        const registryPath = path.join(dir, "registry.json");
        const statePath = path.join(dir, "state");
        if (options.registryJson !== undefined) {
            await writeFile(registryPath, `${JSON.stringify(options.registryJson)}\n`);
        }
        await writeFile(
            path.join(binDir, "sui"),
            `#!/usr/bin/env bash
set -euo pipefail
node - "$@" <<'NODE'
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(args) + "\\n");
const text = fs.existsSync(process.env.STATE_PATH) ? fs.readFileSync(process.env.STATE_PATH, "utf8") : "0";
const count = Number(text.trim() || "0") + 1;
fs.writeFileSync(process.env.STATE_PATH, String(count));
if (args.includes("object")) {
  if (process.env.SCENARIO === "invalid-json") {
    process.stdout.write("{not-json");
    process.exit(0);
  }
  process.stdout.write(fs.readFileSync(process.env.REGISTRY_PATH, "utf8"));
  process.exit(0);
}
const functionName = args[args.indexOf("--function") + 1];
if (process.env.SCENARIO === "normal-error" && functionName === "create_earthquake_verifier_config") {
  process.stderr.write("MoveAbort: ordinary failure\\n");
  process.exit(1);
}
if (process.env.SCENARIO === "create-timeout" && functionName === "create_earthquake_verifier_config") {
  process.stderr.write("Error: CheckpointTimeout waiting for transaction finality\\n");
  process.exit(1);
}
if (functionName.startsWith("create_")) {
  process.stderr.write("MoveAbort EVerifierConfigAlreadyRegistered with code 9\\n");
  process.exit(1);
}
if (
  (process.env.SCENARIO === "timeout" || process.env.SCENARIO === "invalid-json") &&
  functionName === "update_earthquake_verifier_config_pcrs"
) {
  process.stderr.write("Error: CheckpointTimeout waiting for transaction finality\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ ok: true, functionName }));
NODE
`,
        );
        await chmod(path.join(binDir, "sui"), 0o755);

        const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>(
            (resolve) => {
                const child = spawn(
                    "bash",
                    [
                        scriptPath,
                        "--package-id",
                        "0xpackage",
                        "--admin-cap-id",
                        "0xadmincap",
                        "--verifier-registry-id",
                        "0xregistry",
                        "--sui-config",
                        "/tmp/sui-client.yaml",
                        "--sui-env",
                        "devnet",
                        "--earthquake-pcr0",
                        pcrs.earthquake[0],
                        "--earthquake-pcr1",
                        pcrs.earthquake[1],
                        "--earthquake-pcr2",
                        pcrs.earthquake[2],
                        "--identity-pcr0",
                        pcrs.identity[0],
                        "--identity-pcr1",
                        pcrs.identity[1],
                        "--identity-pcr2",
                        pcrs.identity[2],
                        "--census-pcr0",
                        pcrs.census[0],
                        "--census-pcr1",
                        pcrs.census[1],
                        "--census-pcr2",
                        pcrs.census[2],
                    ],
                    {
                        env: {
                            ...process.env,
                            PATH: `${binDir}:${process.env.PATH ?? ""}`,
                            CALLS_PATH: callsPath,
                            REGISTRY_PATH: registryPath,
                            SCENARIO: options.scenario,
                            STATE_PATH: statePath,
                        },
                    },
                );
                const stdout: Buffer[] = [];
                const stderr: Buffer[] = [];
                child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
                child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
                child.on("close", (code) => {
                    resolve({
                        exitCode: code ?? 1,
                        stdout: Buffer.concat(stdout).toString("utf8"),
                        stderr: Buffer.concat(stderr).toString("utf8"),
                    });
                });
            },
        );
        const callsText = await readFile(callsPath, "utf8");
        return {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            calls: callsText.trim().split("\n").filter(Boolean),
        };
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

function registryJson(overrides?: { earthquakePcr0?: unknown }): unknown {
    return {
        data: {
            content: {
                fields: {
                    configs: {
                        fields: {
                            contents: [
                                {
                                    fields: {
                                        key: 3,
                                        value: {
                                            fields: {
                                                verifier_family: 3,
                                                pcr0:
                                                    overrides?.earthquakePcr0 ?? pcrs.earthquake[0],
                                                pcr1: Buffer.from(
                                                    pcrs.earthquake[1],
                                                    "hex",
                                                ).toString("base64"),
                                                pcr2: Array.from(
                                                    Buffer.from(pcrs.earthquake[2], "hex"),
                                                ),
                                            },
                                        },
                                    },
                                },
                            ],
                        },
                    },
                },
            },
        },
    };
}

describe("register-verifier-configs.sh", () => {
    it("recovers from update CheckpointTimeout only after matching on-chain PCR read-back and continues remaining families", async () => {
        const result = await runRegister({ scenario: "timeout", registryJson: registryJson() });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(
            "- update: CheckpointTimeout recovered by on-chain PCR read-back",
        );
        expect(result.stdout).toContain("Registering membership identity config");
        expect(result.stdout).toContain("Registering census config");
        const calls = result.calls.map((line) => JSON.parse(line) as string[]);
        const readBack = calls.find((args) => args.includes("object"));
        expect(readBack).toEqual([
            "client",
            "--client.config",
            "/tmp/sui-client.yaml",
            "--client.env",
            "devnet",
            "object",
            "0xregistry",
            "--json",
        ]);
    });

    it("recovers from create CheckpointTimeout after matching on-chain PCR read-back and continues remaining families", async () => {
        const result = await runRegister({
            scenario: "create-timeout",
            registryJson: registryJson(),
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(
            "- create: CheckpointTimeout recovered by on-chain PCR read-back",
        );
        expect(result.stdout).toContain("Registering membership identity config");
        expect(result.stdout).toContain("Registering census config");
    });

    it("fails closed when CheckpointTimeout read-back PCRs do not match", async () => {
        const result = await runRegister({
            scenario: "timeout",
            registryJson: registryJson({ earthquakePcr0: hex(10) }),
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("earthquake pcr0 mismatch");
    });

    it("fails closed when CheckpointTimeout read-back JSON is invalid", async () => {
        const result = await runRegister({
            scenario: "invalid-json",
            registryJson: registryJson(),
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
            "unable to confirm earthquake config after CheckpointTimeout",
        );
    });

    it("fails closed when CheckpointTimeout read-back does not include the target family config", async () => {
        const result = await runRegister({
            scenario: "timeout",
            registryJson: {
                data: { content: { fields: { configs: { fields: { contents: [] } } } } },
            },
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("family 3 not found");
    });

    it("does not read back or log secrets on ordinary transaction errors", async () => {
        const result = await runRegister({ scenario: "normal-error" });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("ordinary failure");
        expect(result.stderr).not.toContain("super-secret-private-key");
        expect(
            result.calls
                .map((line) => JSON.parse(line) as string[])
                .some((args) => args.includes("object")),
        ).toBe(false);
    });
});
