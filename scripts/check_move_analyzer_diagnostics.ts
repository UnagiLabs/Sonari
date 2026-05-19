import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 30_000;
const DIAGNOSTICS_IDLE_MS = 1_000;
const SUI_GIT_URL = "https://github.com/MystenLabs/sui.git";

type Env = Record<string, string | undefined>;

type JsonRpcMessage = {
    id?: number | string | null;
    jsonrpc?: string;
    method?: string;
    params?: unknown;
    result?: unknown;
};

type LspDiagnostic = {
    code?: number | string;
    message?: string;
    range?: {
        start?: {
            character?: number;
            line?: number;
        };
    };
    severity?: number;
};

export type DiagnosticFinding = {
    code?: string;
    column: number;
    file: string;
    line: number;
    message: string;
    severity: "error" | "warning";
};

export type DiagnosticsResult = {
    findings: DiagnosticFinding[];
    ok: boolean;
};

export type ResolvedMoveAnalyzerBinary = {
    args: string[];
    bin: string;
    installCommand?: string[];
    source: "cache" | "env" | "installed" | "missing-cache";
};

type ResolveOptions = {
    env: Env;
    installIfMissing?: boolean;
    packagePath: string;
    repoRoot: string;
};

type RunOptions = {
    analyzerArgs?: string[];
    analyzerBin: string;
    packagePath: string;
    timeoutMs?: number;
};

type CliOptions = {
    packagePath: string;
    timeoutMs: number;
};

export async function runMoveAnalyzerDiagnostics(options: RunOptions): Promise<DiagnosticsResult> {
    const packagePath = path.resolve(options.packagePath);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const moveFiles = await collectMoveFiles(packagePath);
    if (moveFiles.length === 0) {
        return { findings: [], ok: true };
    }

    return await new Promise<DiagnosticsResult>((resolve, reject) => {
        const child = spawn(options.analyzerBin, options.analyzerArgs ?? [], {
            cwd: packagePath,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const findings: DiagnosticFinding[] = [];
        const seenFindingKeys = new Set<string>();
        let settled = false;
        let readBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        let nextId = 1;
        let idleTimer: NodeJS.Timeout | undefined;

        const stopChild = () => {
            if (!child.killed && child.exitCode === null && child.signalCode === null) {
                if (!child.stdin.destroyed) {
                    sendMessage(child.stdin, {
                        id: nextId++,
                        jsonrpc: "2.0",
                        method: "shutdown",
                        params: null,
                    });
                    sendMessage(child.stdin, {
                        jsonrpc: "2.0",
                        method: "exit",
                        params: null,
                    });
                    child.stdin.end();
                }
                child.kill();
            }
            child.stdout.destroy();
            child.stderr.destroy();
        };

        const finish = (result: DiagnosticsResult) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeoutTimer);
            if (idleTimer !== undefined) {
                clearTimeout(idleTimer);
            }
            stopChild();
            resolve(result);
        };

        const fail = (error: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeoutTimer);
            if (idleTimer !== undefined) {
                clearTimeout(idleTimer);
            }
            stopChild();
            reject(error);
        };

        const scheduleIdleFinish = () => {
            if (idleTimer !== undefined) {
                clearTimeout(idleTimer);
            }
            idleTimer = setTimeout(() => {
                finish({ findings, ok: findings.length === 0 });
            }, DIAGNOSTICS_IDLE_MS);
        };

        const timeoutTimer = setTimeout(() => {
            fail(new Error(`move-analyzer did not finish diagnostics within ${timeoutMs}ms`));
        }, timeoutMs);

        child.once("error", (error) => {
            fail(error);
        });

        child.stderr.on("data", () => {
            // move-analyzer writes progress logs to stderr; keep hook output focused on diagnostics.
        });

        child.stdout.on("data", (chunk: Buffer) => {
            readBuffer = Buffer.concat([readBuffer, chunk]);
            for (;;) {
                const parsed = parseLspMessage(readBuffer);
                if (parsed === undefined) {
                    return;
                }
                readBuffer = parsed.rest;
                handleMessage(parsed.message);
            }
        });

        const initializeId = nextId++;
        sendMessage(child.stdin, {
            id: initializeId,
            jsonrpc: "2.0",
            method: "initialize",
            params: {
                capabilities: {},
                initializationOptions: {
                    lintLevel: "all",
                },
                processId: process.pid,
                rootPath: packagePath,
                rootUri: pathToFileURL(packagePath).toString(),
                workspaceFolders: [
                    {
                        name: path.basename(packagePath),
                        uri: pathToFileURL(packagePath).toString(),
                    },
                ],
            },
        });

        function handleMessage(message: JsonRpcMessage) {
            if (message.id === initializeId) {
                sendMessage(child.stdin, {
                    jsonrpc: "2.0",
                    method: "initialized",
                    params: {},
                });
                void openMoveFiles(child.stdin, moveFiles);
                return;
            }
            if (message.method !== "textDocument/publishDiagnostics") {
                return;
            }

            const params = asDiagnosticParams(message.params);
            if (params === undefined) {
                return;
            }
            for (const diagnostic of params.diagnostics) {
                const finding = toFinding(params.uri, diagnostic);
                if (finding !== undefined) {
                    const key = formatFinding(finding);
                    if (!seenFindingKeys.has(key)) {
                        seenFindingKeys.add(key);
                        findings.push(finding);
                    }
                }
            }
            scheduleIdleFinish();
        }
    });
}

export async function resolveMoveAnalyzerBinary(
    options: ResolveOptions,
): Promise<ResolvedMoveAnalyzerBinary> {
    const envBin = options.env.MOVE_ANALYZER_BIN?.trim();
    if (envBin !== undefined && envBin.length > 0) {
        return { args: [], bin: envBin, source: "env" };
    }

    const rev = await readPinnedMoveAnalyzerRev(
        path.join(options.packagePath, "Move.lock"),
        options.env,
    );
    const installRoot = path.join(options.repoRoot, ".cache", "move-analyzer", rev);
    const bin = path.join(installRoot, "bin", "move-analyzer");
    const installCommand = [
        "cargo",
        "install",
        "--git",
        SUI_GIT_URL,
        "--rev",
        rev,
        "sui-move-lsp",
        "--root",
        installRoot,
    ];

    if (existsSync(bin)) {
        return { args: [], bin, source: "cache" };
    }
    if (options.installIfMissing === false) {
        return { args: [], bin, installCommand, source: "missing-cache" };
    }

    await mkdir(installRoot, { recursive: true });
    const [installProgram, ...installArgs] = installCommand;
    if (installProgram === undefined) {
        throw new Error("Unable to build move-analyzer install command");
    }
    const result = spawnSync(installProgram, installArgs, {
        encoding: "utf8",
        stdio: "inherit",
    });
    if (result.status !== 0 || !existsSync(bin)) {
        throw new Error(
            [
                "Failed to install move-analyzer.",
                `Install command: ${installCommand.join(" ")}`,
                "Set MOVE_ANALYZER_BIN to an existing move-analyzer binary to skip auto install.",
            ].join("\n"),
        );
    }

    return { args: [], bin, source: "installed" };
}

export async function readPinnedMoveAnalyzerRev(moveLockPath: string, env: Env): Promise<string> {
    const envRev = env.MOVE_ANALYZER_GIT_REV?.trim();
    if (envRev !== undefined && envRev.length > 0) {
        return envRev;
    }

    const contents = await readFile(moveLockPath, "utf8");
    const revByPackage = new Map<string, string>();
    let currentPackage: string | undefined;
    for (const line of contents.split(/\r?\n/)) {
        const sectionMatch = /^\[pinned(?:\.[^\].]+)*\.(Sui|MoveStdlib)\]$/.exec(line.trim());
        if (sectionMatch !== null) {
            currentPackage = sectionMatch[1];
            continue;
        }
        const revMatch = /\brev\s*=\s*"([^"]+)"/.exec(line);
        if (currentPackage !== undefined && revMatch !== null) {
            const rev = revMatch[1];
            if (rev !== undefined) {
                revByPackage.set(currentPackage, rev);
            }
            currentPackage = undefined;
        }
    }

    const rev = revByPackage.get("Sui") ?? revByPackage.get("MoveStdlib");
    if (rev === undefined) {
        throw new Error(`Unable to find pinned Sui or MoveStdlib rev in ${moveLockPath}`);
    }
    return rev;
}

export function formatFinding(finding: DiagnosticFinding): string {
    const code = finding.code === undefined ? "" : ` [${finding.code}]`;
    return `${finding.file}:${finding.line}:${finding.column} ${finding.severity}${code} ${finding.message}`;
}

async function main() {
    const cliOptions = parseCliOptions(process.argv.slice(2));
    const packagePath = path.resolve(cliOptions.packagePath);
    const repoRoot = findRepoRoot(process.cwd());
    const analyzer = await resolveMoveAnalyzerBinary({
        env: process.env,
        packagePath,
        repoRoot,
    });
    const result = await runMoveAnalyzerDiagnostics({
        analyzerArgs: analyzer.args,
        analyzerBin: analyzer.bin,
        packagePath,
        timeoutMs: cliOptions.timeoutMs,
    });

    if (!result.ok) {
        for (const finding of result.findings) {
            console.error(formatFinding(finding));
        }
        process.exitCode = 1;
        return;
    }
    console.log("move-analyzer diagnostics: ok");
}

function parseCliOptions(args: string[]): CliOptions {
    let packagePath: string | undefined;
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === undefined) {
            continue;
        }
        if (arg === "--timeout-ms") {
            const value = args[index + 1];
            if (value === undefined) {
                throw new Error("--timeout-ms requires a value");
            }
            timeoutMs = parsePositiveInteger(value, "--timeout-ms");
            index += 1;
            continue;
        }
        if (arg.startsWith("--timeout-ms=")) {
            timeoutMs = parsePositiveInteger(arg.slice("--timeout-ms=".length), "--timeout-ms");
            continue;
        }
        if (arg.startsWith("-")) {
            throw new Error(`Unknown option: ${arg}`);
        }
        packagePath = arg;
    }
    if (packagePath === undefined) {
        throw new Error(
            "Usage: check_move_analyzer_diagnostics.ts <move-package-path> [--timeout-ms N]",
        );
    }
    return { packagePath, timeoutMs };
}

function parsePositiveInteger(value: string, name: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
}

async function collectMoveFiles(packagePath: string): Promise<string[]> {
    const roots = [path.join(packagePath, "sources"), path.join(packagePath, "tests")];
    const files: string[] = [];
    for (const root of roots) {
        if (!existsSync(root)) {
            continue;
        }
        files.push(...(await collectMoveFilesFromDir(root)));
    }
    return files.sort();
}

async function collectMoveFilesFromDir(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await collectMoveFilesFromDir(entryPath)));
            continue;
        }
        if (entry.isFile() && entry.name.endsWith(".move")) {
            files.push(entryPath);
        }
    }
    return files;
}

async function openMoveFiles(stdin: NodeJS.WritableStream, moveFiles: string[]) {
    for (const file of moveFiles) {
        sendMessage(stdin, {
            jsonrpc: "2.0",
            method: "textDocument/didOpen",
            params: {
                textDocument: {
                    languageId: "move",
                    text: await readFile(file, "utf8"),
                    uri: pathToFileURL(file).toString(),
                    version: 1,
                },
            },
        });
    }
}

function parseLspMessage(
    buffer: Buffer<ArrayBufferLike>,
): { message: JsonRpcMessage; rest: Buffer<ArrayBufferLike> } | undefined {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
        return undefined;
    }
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
    if (lengthMatch === null) {
        throw new Error("LSP message is missing Content-Length");
    }
    const contentLength = Number(lengthMatch[1]);
    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + contentLength;
    if (buffer.length < messageEnd) {
        return undefined;
    }
    return {
        message: JSON.parse(
            buffer.subarray(messageStart, messageEnd).toString("utf8"),
        ) as JsonRpcMessage,
        rest: buffer.subarray(messageEnd),
    };
}

function sendMessage(stdin: NodeJS.WritableStream, message: JsonRpcMessage) {
    const body = JSON.stringify(message);
    stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function asDiagnosticParams(
    params: unknown,
): { diagnostics: LspDiagnostic[]; uri: string } | undefined {
    if (typeof params !== "object" || params === null) {
        return undefined;
    }
    const uri = "uri" in params ? params.uri : undefined;
    const diagnostics = "diagnostics" in params ? params.diagnostics : undefined;
    if (typeof uri !== "string" || !Array.isArray(diagnostics)) {
        return undefined;
    }
    return { diagnostics: diagnostics.filter(isLspDiagnostic), uri };
}

function isLspDiagnostic(value: unknown): value is LspDiagnostic {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    return "range" in value && "message" in value;
}

function toFinding(uri: string, diagnostic: LspDiagnostic): DiagnosticFinding | undefined {
    const severity =
        diagnostic.severity === 1 ? "error" : diagnostic.severity === 2 ? "warning" : undefined;
    if (severity === undefined) {
        return undefined;
    }
    const line = diagnostic.range?.start?.line;
    const character = diagnostic.range?.start?.character;
    if (typeof line !== "number" || typeof character !== "number") {
        return undefined;
    }
    const message = diagnostic.message;
    if (typeof message !== "string") {
        return undefined;
    }
    const finding: DiagnosticFinding = {
        column: character + 1,
        file: fileURLToPathname(uri),
        line: line + 1,
        message,
        severity,
    };
    if (diagnostic.code !== undefined) {
        finding.code = String(diagnostic.code);
    }
    return finding;
}

function fileURLToPathname(uri: string): string {
    if (!uri.startsWith("file://")) {
        return uri;
    }
    return new URL(uri).pathname;
}

function findRepoRoot(startDir: string): string {
    let current = path.resolve(startDir);
    for (;;) {
        if (existsSync(path.join(current, ".git"))) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return path.resolve(startDir);
        }
        current = parent;
    }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").toString()) {
    main().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        process.exitCode = 1;
    });
}
