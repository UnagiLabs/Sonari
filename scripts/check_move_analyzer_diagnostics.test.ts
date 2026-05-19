import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
    formatFinding,
    readPinnedMoveAnalyzerRev,
    resolveMoveAnalyzerBinary,
    runMoveAnalyzerDiagnostics,
} from "./check_move_analyzer_diagnostics.js";

describe("move analyzer diagnostics checker", () => {
    it("fails when the LSP publishes a warning diagnostic", async () => {
        const fixture = await createMoveFixture();
        const serverPath = await writeFakeLspServer(fixture.dir, {
            diagnostics: [
                {
                    range: {
                        start: { line: 6, character: 17 },
                        end: { line: 6, character: 23 },
                    },
                    severity: 2,
                    code: "W02021",
                    message: "Unnecessary alias 'Option'",
                },
                {
                    range: {
                        start: { line: 6, character: 17 },
                        end: { line: 6, character: 23 },
                    },
                    severity: 2,
                    code: "W02021",
                    message: "Unnecessary alias 'Option'",
                },
            ],
        });

        try {
            const result = await runMoveAnalyzerDiagnostics({
                analyzerBin: process.execPath,
                analyzerArgs: [serverPath],
                packagePath: fixture.packagePath,
                timeoutMs: 5_000,
            });

            expect(result.ok).toBe(false);
            expect(result.findings).toEqual([
                expect.objectContaining({
                    line: 7,
                    column: 18,
                    severity: "warning",
                    code: "W02021",
                    message: "Unnecessary alias 'Option'",
                }),
            ]);
        } finally {
            await rm(fixture.dir, { recursive: true, force: true });
        }
    });

    it("succeeds when the LSP publishes no diagnostics", async () => {
        const fixture = await createMoveFixture();
        const serverPath = await writeFakeLspServer(fixture.dir, { diagnostics: [] });

        try {
            const result = await runMoveAnalyzerDiagnostics({
                analyzerBin: process.execPath,
                analyzerArgs: [serverPath],
                packagePath: fixture.packagePath,
                timeoutMs: 5_000,
            });

            expect(result).toEqual({ ok: true, findings: [] });
        } finally {
            await rm(fixture.dir, { recursive: true, force: true });
        }
    });

    it("prefers MOVE_ANALYZER_BIN over repo-local cache resolution", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "sonari-move-analyzer-test-"));
        try {
            const resolved = await resolveMoveAnalyzerBinary({
                env: { MOVE_ANALYZER_BIN: "/custom/move-analyzer" },
                packagePath: path.join(dir, "contracts"),
                repoRoot: dir,
            });

            expect(resolved).toEqual({
                args: [],
                bin: "/custom/move-analyzer",
                source: "env",
            });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("selects the repo-local install path and command when the binary is missing", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "sonari-move-analyzer-test-"));
        try {
            const contractsDir = path.join(dir, "contracts");
            await mkdir(contractsDir);
            await writeFile(
                path.join(contractsDir, "Move.lock"),
                [
                    "[pinned.testnet.Sui]",
                    'source = { git = "https://github.com/MystenLabs/sui.git", rev = "abc123" }',
                ].join("\n"),
            );

            const resolved = await resolveMoveAnalyzerBinary({
                env: {},
                packagePath: contractsDir,
                repoRoot: dir,
                installIfMissing: false,
            });

            expect(resolved).toEqual({
                args: [],
                bin: path.join(dir, ".cache", "move-analyzer", "abc123", "bin", "move-analyzer"),
                installCommand: [
                    "cargo",
                    "install",
                    "--git",
                    "https://github.com/MystenLabs/sui.git",
                    "--rev",
                    "abc123",
                    "sui-move-lsp",
                    "--root",
                    path.join(dir, ".cache", "move-analyzer", "abc123"),
                ],
                source: "missing-cache",
            });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("reads the pinned Sui rev from Move.lock", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "sonari-move-analyzer-test-"));
        try {
            const moveLockPath = path.join(dir, "Move.lock");
            await writeFile(
                moveLockPath,
                [
                    "[pinned.testnet.MoveStdlib]",
                    'source = { git = "https://github.com/MystenLabs/sui.git", rev = "stdlib-rev" }',
                    "",
                    "[pinned.testnet.Sui]",
                    'source = { git = "https://github.com/MystenLabs/sui.git", rev = "sui-rev" }',
                ].join("\n"),
            );

            await expect(readPinnedMoveAnalyzerRev(moveLockPath, {})).resolves.toBe("sui-rev");
            await expect(
                readPinnedMoveAnalyzerRev(moveLockPath, {
                    MOVE_ANALYZER_GIT_REV: "override-rev",
                }),
            ).resolves.toBe("override-rev");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("formats diagnostics for Codex-readable output", () => {
        expect(
            formatFinding({
                code: "W02021",
                column: 18,
                file: "/repo/contracts/sources/accessor.move",
                line: 7,
                message: "Unnecessary alias 'Option'",
                severity: "warning",
            }),
        ).toBe(
            "/repo/contracts/sources/accessor.move:7:18 warning [W02021] Unnecessary alias 'Option'",
        );
    });
});

async function createMoveFixture(): Promise<{ dir: string; packagePath: string }> {
    const dir = await mkdtemp(path.join(tmpdir(), "sonari-move-analyzer-test-"));
    const packagePath = path.join(dir, "contracts");
    await mkdir(path.join(packagePath, "sources"), { recursive: true });
    await writeFile(
        path.join(packagePath, "Move.toml"),
        ["[package]", 'name = "contracts"', 'edition = "2024"', ""].join("\n"),
    );
    await writeFile(
        path.join(packagePath, "sources", "accessor.move"),
        [
            "module contracts::accessor;",
            "",
            "use std::option::Option;",
            "",
            "public fun option_id(id: Option<u64>): Option<u64> {",
            "    id",
            "}",
            "",
        ].join("\n"),
    );
    return { dir, packagePath };
}

async function writeFakeLspServer(
    dir: string,
    options: { diagnostics: Array<Record<string, unknown>> },
): Promise<string> {
    const serverPath = path.join(dir, "fake-lsp-server.mjs");
    await writeFile(
        serverPath,
        `
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = /Content-Length: (\\d+)/i.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + length;
    if (buffer.length < messageEnd) return;
    const payload = JSON.parse(buffer.subarray(messageStart, messageEnd).toString("utf8"));
    buffer = buffer.subarray(messageEnd);
    handle(payload);
  }
});

function send(payload) {
  const body = JSON.stringify(payload);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
}

function handle(payload) {
  if (payload.method === "initialize") {
    send({ jsonrpc: "2.0", id: payload.id, result: { capabilities: { textDocumentSync: 1 } } });
    return;
  }
  if (payload.method === "textDocument/didOpen") {
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri: payload.params.textDocument.uri, diagnostics: ${JSON.stringify(options.diagnostics)} },
    });
    return;
  }
  if (payload.method === "shutdown") {
    send({ jsonrpc: "2.0", id: payload.id, result: null });
  }
  if (payload.method === "exit") {
    process.exit(0);
  }
}
`,
    );
    return serverPath;
}
