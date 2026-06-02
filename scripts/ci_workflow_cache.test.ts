import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = path.join(process.cwd(), ".github/workflows/ci.yml");

async function readWorkflow(): Promise<string> {
    return readFile(workflowPath, "utf8");
}

function expectContainsAll(source: string, expected: readonly string[]): void {
    for (const value of expected) {
        expect(source).toContain(value);
    }
}

describe("CI workflow cache and Move checks", () => {
    it("installs Rust formatting and Clippy components before pnpm check", async () => {
        const workflow = await readWorkflow();

        expectContainsAll(workflow, [
            "rustup toolchain install stable --profile minimal --component rustfmt --component clippy",
            "pnpm check",
        ]);
    });

    it("caches pnpm and Cargo dependencies with lockfile based keys", async () => {
        const workflow = await readWorkflow();

        expectContainsAll(workflow, [
            "actions/cache@v5",
            "pnpm-store-$" + "{{ runner.os }}-$" + "{{ hashFiles('pnpm-lock.yaml') }}",
            "pnpm store path --silent",
            "cargo-$" +
                "{{ runner.os }}-$" +
                "{{ hashFiles('nautilus/verifiers/earthquake/tee/Cargo.lock', 'nautilus/verifiers/earthquake/tee/Cargo.toml') }}",
            "~/.cargo/registry",
            "~/.cargo/git",
            "nautilus/verifiers/earthquake/tee/target",
        ]);
    });

    it("runs Move checks in CI only when Move-related files changed", async () => {
        const workflow = await readWorkflow();

        expectContainsAll(workflow, [
            "Detect Move changes",
            "id: move-changes",
            "contracts/",
            "Move.toml",
            "Move.lock",
            "Install pinned Sui CLI",
            "sui-cli-$" + "{{ runner.os }}-$" + "{{ env.SUI_CLI_SHA256 }}",
            "https://github.com/MystenLabs/sui/releases/download/testnet-v1.71.1/sui-testnet-v1.71.1-ubuntu-x86_64.tgz",
            "ca6bc791596d5def88500b653b5db718e72dd0d2b58039ad118f74ef9e6761a5",
            "pnpm check:move",
            "if: steps.move-changes.outputs.changed == 'true'",
        ]);
    });
});
