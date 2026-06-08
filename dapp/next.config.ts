import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const proofCoreSrc = "../packages/proof-core/src";

// membership package ID は contracts/Published.toml（commit 済み＝GitHub 管理の正典）を
// 単一の出所とし、ビルド時にここで読み取って NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID へ注入する。
// env への手書きをやめることで「再 publish のたびに env と toml の両方を直す」二重管理を解消する。
type SonariNetwork = "testnet" | "localnet";

// network 解決は wallet-network.ts と同じ意味（"localnet" 厳密一致以外は testnet）だが、
// config を app のモジュールグラフへ結合させないため import せず inline する。
function resolveSonariNetwork(raw: string | undefined): SonariNetwork {
    return (raw ?? "").trim() === "localnet" ? "localnet" : "testnet";
}

// scripts/membership_identity_testnet_fixture.ts の parsePublishedTomlPackageId と同じ
// inline-regex 流儀。あちらは node:child_process / @mysten/sui / proof-core を引き込み型も
// 不一致のため import せず再実装する。不正入力では throw せず undefined を返し、ビルドを止めない。
function parsePublishedTomlPackageId(input: string, network: SonariNetwork): string | undefined {
    const section = new RegExp(`\\[published\\.${network}\\]([\\s\\S]*?)(?:\\n\\[|$)`).exec(
        input,
    )?.[1];
    if (section === undefined) {
        return undefined;
    }
    const publishedAt = /^\s*published-at\s*=\s*"([^"]+)"/m.exec(section)?.[1];
    if (publishedAt === undefined || !/^0x[0-9a-fA-F]+$/.test(publishedAt)) {
        return undefined;
    }
    return publishedAt;
}

// Published.toml の欠落・不正は読めなければ undefined（既存挙動どおり空 → 照会 error → ボタン無効）。
function readPublishedTomlPackageId(network: SonariNetwork): string | undefined {
    try {
        return parsePublishedTomlPackageId(
            readFileSync(`${repoRoot}/contracts/Published.toml`, "utf8"),
            network,
        );
    } catch {
        return undefined;
    }
}

const sonariNetwork = resolveSonariNetwork(process.env.NEXT_PUBLIC_SUI_NETWORK);
// env に値があれば優先（localnet/dev 用＋将来 CI で明示注入したい場合の逃げ道）、
// なければ Published.toml の published-at、それも無ければ空文字へ degrade する。
const membershipPackageId =
    (process.env.NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID?.trim() ||
        readPublishedTomlPackageId(sonariNetwork)) ??
    "";

const nextConfig: NextConfig = {
    transpilePackages: ["@sonari/proof-core"],
    // 単一チャネル（env config）で注入。define-env は config の env を .env より後に spread する
    // ため、.env 側に同名値があっても override-wins で一貫する（NEXT_PUBLIC_* の二重定義は衝突扱いされない）。
    env: {
        NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID: membershipPackageId,
    },
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
            "./identity-statement-hash.js": `${proofCoreSrc}/identity-statement-hash.ts`,
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
