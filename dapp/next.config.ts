import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const nextConfig: NextConfig = {
    output: "export",
    images: {
        unoptimized: true,
    },
    turbopack: {
        root: repoRoot,
    },
};

export default nextConfig;
