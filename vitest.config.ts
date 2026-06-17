import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: {
            "cloudflare:workers": fileURLToPath(
                new URL(
                    "./packages/affected-cells-proof-worker/src/test_cloudflare_workers.ts",
                    import.meta.url,
                ),
            ),
            "cloudflare:workflows": fileURLToPath(
                new URL(
                    "./packages/affected-cells-proof-worker/src/test_cloudflare_workflows.ts",
                    import.meta.url,
                ),
            ),
        },
    },
    test: {
        exclude: [
            "**/node_modules/**",
            "**/.git/**",
            ".build/**",
            "**/.build/**",
            ".codex/**",
            "**/.codex/**",
        ],
    },
});
