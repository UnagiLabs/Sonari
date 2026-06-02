import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageJsonPath = path.join(process.cwd(), "package.json");

describe("Rust check gate", () => {
    it("runs Clippy against all Rust targets and treats warnings as failures", async () => {
        const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
            scripts?: Record<string, string>;
        };

        expect(packageJson.scripts?.["check:rust"]).toBe(
            "cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings",
        );
    });
});
