import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const proofCoreSrc = "../packages/proof-core/src";

const nextConfig: NextConfig = {
    transpilePackages: ["@sonari/proof-core"],
    images: {
        unoptimized: true,
    },
    turbopack: {
        root: repoRoot,
        resolveAlias: {
            "./affected-cell-leaf.js": `${proofCoreSrc}/affected-cell-leaf.ts`,
            "./affected-cells.js": `${proofCoreSrc}/affected-cells.ts`,
            "./bytes.js": `${proofCoreSrc}/bytes.ts`,
            "./constants.js": `${proofCoreSrc}/constants.ts`,
            "./h3.js": `${proofCoreSrc}/h3.ts`,
            "./leaf-hash.js": `${proofCoreSrc}/leaf-hash.ts`,
            "./manifest.js": `${proofCoreSrc}/manifest.ts`,
            "./merkle.js": `${proofCoreSrc}/merkle.ts`,
            "./schema.js": `${proofCoreSrc}/schema.ts`,
            "./shard.js": `${proofCoreSrc}/shard.ts`,
            "./world-id-signal.js": `${proofCoreSrc}/world-id-signal.ts`,
        },
    },
};

export default nextConfig;
