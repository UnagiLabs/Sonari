import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceExtensions = new Set([".ts", ".tsx"]);

function collectSourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const path = resolve(dir, entry);
        const stat = statSync(path);
        if (stat.isDirectory()) {
            collectSourceFiles(path, out);
            continue;
        }

        if (!sourceExtensions.has(extname(path))) {
            continue;
        }

        if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) {
            continue;
        }

        out.push(path);
    }

    return out;
}

describe("leaderboard dead links", () => {
    it("画面用コードに /leaderboard への導線を残さない", () => {
        const offenders = collectSourceFiles(appDir)
            .filter((path) => readFileSync(path, "utf8").includes('"/leaderboard"'))
            .map((path) => relative(appDir, path));

        expect(offenders).toEqual([]);
    });
});
