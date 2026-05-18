import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
    name: string;
    status: DoctorStatus;
    message: string;
}

export interface OracleDoctorOptions {
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    migrationsDir?: string;
    schemaSqlPath?: string;
}

export interface OracleDoctorResult {
    ok: boolean;
    checks: DoctorCheck[];
}

const DEFAULT_MIGRATIONS_DIR = "nautilus/verifiers/disaster/watcher/migrations";
const DEFAULT_SCHEMA_SQL_PATH = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/**/db.sqlite";
const RELAYER_MODES = new Set(["preview", "dry_run", "submit"]);
const REQUIRED_D1_COLUMNS = [
    "runner_job_id",
    "runner_stop_error",
    "relayer_mode",
    "relayer_status",
    "relayer_submitted_at_ms",
];

export async function runOracleDoctor(
    options: OracleDoctorOptions = {},
): Promise<OracleDoctorResult> {
    const env = options.env ?? process.env;
    const checks: DoctorCheck[] = [];

    checks.push(checkRelayerMode(env.RELAYER_MODE));
    checks.push(checkBooleanFlag("RELAYER_ALLOW_SUBMIT", env.RELAYER_ALLOW_SUBMIT));
    checks.push(checkRequiredForMode("RELAYER_GRPC_URL", env.RELAYER_GRPC_URL, env.RELAYER_MODE));
    checks.push(
        checkRequiredForMode(
            "RELAYER_SENDER_ADDRESS",
            env.RELAYER_SENDER_ADDRESS,
            env.RELAYER_MODE,
        ),
    );
    checks.push(checkOptionalSecretPair("AWS_RUNNER_BASE_URL", env.AWS_RUNNER_BASE_URL));
    checks.push(checkOptionalSecretPair("AWS_RUNNER_TOKEN", env.AWS_RUNNER_TOKEN));
    checks.push(checkOptionalSecretPair("MANUAL_SUBMIT_TOKEN", env.MANUAL_SUBMIT_TOKEN));
    checks.push(
        await checkD1Consistency(
            options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR,
            options.schemaSqlPath ?? DEFAULT_SCHEMA_SQL_PATH,
        ),
    );

    return {
        ok: checks.every((check) => check.status !== "fail"),
        checks,
    };
}

function checkRelayerMode(value: string | undefined): DoctorCheck {
    const mode = value ?? "preview";
    if (!RELAYER_MODES.has(mode)) {
        return {
            name: "RELAYER_MODE",
            status: "fail",
            message: `unsupported mode: ${mode}`,
        };
    }
    return {
        name: "RELAYER_MODE",
        status: "ok",
        message: mode,
    };
}

function checkBooleanFlag(name: string, value: string | undefined): DoctorCheck {
    if (value === "true") {
        return { name, status: "ok", message: "enabled" };
    }
    if (value === undefined || value.length === 0 || value === "false") {
        return { name, status: "warn", message: "not enabled" };
    }
    return { name, status: "fail", message: "must be true or false when set" };
}

function checkRequiredForMode(
    name: string,
    value: string | undefined,
    modeValue: string | undefined,
): DoctorCheck {
    const mode = modeValue ?? "preview";
    if (mode !== "dry_run") {
        return { name, status: "warn", message: "not required outside dry_run mode" };
    }
    if (value !== undefined && value.length > 0) {
        return { name, status: "ok", message: "configured" };
    }
    return { name, status: "fail", message: "required for RELAYER_MODE=dry_run" };
}

function checkOptionalSecretPair(name: string, value: string | undefined): DoctorCheck {
    if (value !== undefined && value.length > 0) {
        return { name, status: "ok", message: "configured" };
    }
    return { name, status: "warn", message: "not configured" };
}

async function checkD1Consistency(
    migrationsDir: string,
    schemaSqlPath: string,
): Promise<DoctorCheck> {
    try {
        const migrationSql = await readMigrationSql(migrationsDir);
        const missingColumns = REQUIRED_D1_COLUMNS.filter(
            (column) => !migrationSql.includes(`ADD COLUMN ${column}`),
        );
        if (missingColumns.length > 0) {
            return {
                name: "D1_MIGRATIONS",
                status: "fail",
                message: `missing migration columns: ${missingColumns.join(", ")}`,
            };
        }

        const schemaExists = await localD1SqliteExists(schemaSqlPath);
        return {
            name: "D1_MIGRATIONS",
            status: schemaExists ? "ok" : "warn",
            message: schemaExists
                ? "migrations and local D1 sqlite are present"
                : "migrations are present; local D1 sqlite was not found",
        };
    } catch (error) {
        return {
            name: "D1_MIGRATIONS",
            status: "fail",
            message: error instanceof Error ? error.message : String(error),
        };
    }
}

async function readMigrationSql(migrationsDir: string): Promise<string> {
    const entries = await readdir(migrationsDir);
    const sqlFiles = entries.filter((entry) => entry.endsWith(".sql")).sort();
    if (sqlFiles.length === 0) {
        throw new Error(`no migration files found in ${migrationsDir}`);
    }
    const contents = await Promise.all(
        sqlFiles.map((file) => readFile(path.join(migrationsDir, file), "utf8")),
    );
    return contents.join("\n");
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        return (await stat(filePath)).isFile();
    } catch {
        return false;
    }
}

async function localD1SqliteExists(schemaSqlPath: string): Promise<boolean> {
    if (await fileExists(schemaSqlPath)) {
        return true;
    }
    const wildcardIndex = schemaSqlPath.indexOf("*");
    if (wildcardIndex === -1) {
        return false;
    }

    const searchRoot = schemaSqlPath.slice(0, wildcardIndex).replace(/[\\/]+$/, "");
    const targetName = path.basename(schemaSqlPath);
    return fileNamedExists(searchRoot.length === 0 ? "." : searchRoot, targetName);
}

async function fileNamedExists(directory: string, targetName: string): Promise<boolean> {
    let entries: Dirent[];
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch {
        return false;
    }

    for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isFile() && entry.name === targetName) {
            return true;
        }
        if (entry.isDirectory() && (await fileNamedExists(entryPath, targetName))) {
            return true;
        }
    }
    return false;
}

async function main(): Promise<void> {
    const result = await runOracleDoctor();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
}

const mainPath = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (mainPath !== null && import.meta.url === mainPath) {
    main().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
