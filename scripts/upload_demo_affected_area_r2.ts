import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { affectedAreaR2ObjectPrefix } from "../dapp/app/claim/affected-area/affected-area-artifact.js";
import { stageAffectedAreaR2Artifacts } from "./stage_demo_affected_area_r2.js";

const DEFAULT_INPUT_DIR = "dapp/public/demo/tohoku-2011";
const DEFAULT_OUTPUT_DIR = ".build/affected-area-r2/tohoku-2011";
const DEFAULT_EVENT_REVISION = 1;
const DEFAULT_CACHE_CONTROL = "public, max-age=31536000, immutable";
const DEFAULT_UPLOAD_CONCURRENCY = 8;

export interface AffectedAreaR2UploadPlanItem {
    readonly filePath: string;
    readonly objectPath: string;
    readonly contentType: string;
    readonly cacheControl: string;
}

export interface BuildAffectedAreaR2UploadPlanParams {
    readonly bucket: string;
    readonly outputDir: string;
    readonly objectPrefix: string;
    readonly cacheControl?: string;
}

function requiredEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (value === undefined || value.length === 0) {
        throw new Error(`${name} is required`);
    }
    return value;
}

function parsePositiveInteger(name: string, value: string | undefined): number {
    const raw = value?.trim();
    if (raw === undefined || raw.length === 0) {
        throw new Error(`${name} is required`);
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
}

function optionalPositiveInteger(
    name: string,
    value: string | undefined,
    fallback: number,
): number {
    const raw = value?.trim();
    if (raw === undefined || raw.length === 0) {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
}

function contentTypeForFile(filePath: string): string {
    if (filePath.endsWith(".json")) {
        return "application/json";
    }
    if (filePath.endsWith(".svg")) {
        return "image/svg+xml";
    }
    return "application/octet-stream";
}

async function listFiles(root: string): Promise<string[]> {
    const result: string[] = [];
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            result.push(...(await listFiles(fullPath)));
        } else if (entry.isFile()) {
            result.push(fullPath);
        }
    }
    return result.sort();
}

export async function buildAffectedAreaR2UploadPlan(
    params: BuildAffectedAreaR2UploadPlanParams,
): Promise<AffectedAreaR2UploadPlanItem[]> {
    const outputStat = await stat(params.outputDir);
    if (!outputStat.isDirectory()) {
        throw new Error(`outputDir is not a directory: ${params.outputDir}`);
    }

    const cacheControl = params.cacheControl ?? DEFAULT_CACHE_CONTROL;
    const files = await listFiles(params.outputDir);
    return files.map((filePath) => {
        const relativePath = path.relative(params.outputDir, filePath).split(path.sep).join("/");
        return {
            filePath,
            objectPath: `${params.bucket}/${params.objectPrefix}/${relativePath}`,
            contentType: contentTypeForFile(filePath),
            cacheControl,
        };
    });
}

async function runWranglerPut(item: AffectedAreaR2UploadPlanItem): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        let output = "";
        const child = spawn(
            "wrangler",
            [
                "r2",
                "object",
                "put",
                item.objectPath,
                "--file",
                item.filePath,
                "--content-type",
                item.contentType,
                "--cache-control",
                item.cacheControl,
                "--remote",
                "--force",
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
        );
        child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
            output += chunk.toString("utf8");
        });
        child.on("error", reject);
        child.on("exit", (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(
                new Error(
                    `wrangler r2 object put failed for ${item.objectPath}: exit ${code}\n${output}`,
                ),
            );
        });
    });
}

async function uploadWithConcurrency(
    plan: readonly AffectedAreaR2UploadPlanItem[],
    concurrency: number,
): Promise<void> {
    let nextIndex = 0;
    let uploaded = 0;

    async function worker(): Promise<void> {
        while (true) {
            const index = nextIndex;
            nextIndex += 1;
            const item = plan[index];
            if (item === undefined) {
                return;
            }
            await runWranglerPut(item);
            uploaded += 1;
            if (uploaded === 1 || uploaded === plan.length || uploaded % 100 === 0) {
                process.stdout.write(`uploaded ${uploaded}/${plan.length}\n`);
            }
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(concurrency, plan.length) }, async () => worker()),
    );
}

async function main(): Promise<void> {
    const inputDir = process.env.SONARI_AFFECTED_AREA_INPUT_DIR?.trim() || DEFAULT_INPUT_DIR;
    const outputDir = process.env.SONARI_AFFECTED_AREA_R2_STAGE_DIR?.trim() || DEFAULT_OUTPUT_DIR;
    const baseUrl = requiredEnv("NEXT_PUBLIC_SONARI_AFFECTED_AREA_BASE_URL");
    const bucket = requiredEnv("SONARI_AFFECTED_AREA_R2_BUCKET");
    const eventRevision = parsePositiveInteger(
        "SONARI_AFFECTED_AREA_EVENT_REVISION",
        process.env.SONARI_AFFECTED_AREA_EVENT_REVISION ?? String(DEFAULT_EVENT_REVISION),
    );
    const concurrency = optionalPositiveInteger(
        "SONARI_AFFECTED_AREA_R2_UPLOAD_CONCURRENCY",
        process.env.SONARI_AFFECTED_AREA_R2_UPLOAD_CONCURRENCY,
        DEFAULT_UPLOAD_CONCURRENCY,
    );

    const staged = await stageAffectedAreaR2Artifacts({
        inputDir,
        outputDir,
        baseUrl,
        eventRevision,
    });
    const objectPrefix = affectedAreaR2ObjectPrefix({
        eventUid: staged.manifest.eventUid,
        eventRevision,
    });
    const plan = await buildAffectedAreaR2UploadPlan({
        bucket,
        outputDir,
        objectPrefix,
    });

    process.stdout.write(
        `uploading ${plan.length} affected-area files with Wrangler (${concurrency} concurrent)\n`,
    );
    await uploadWithConcurrency(plan, concurrency);
    process.stdout.write(`uploaded affected-area artifacts to r2://${bucket}/${objectPrefix}/\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    });
}
