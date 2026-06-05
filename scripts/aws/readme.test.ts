import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readmePath = path.join(process.cwd(), "scripts/aws/README.md");
const agentsPath = path.join(process.cwd(), "AGENTS.md");

describe("AWS scripts documentation", () => {
    it("indexes the local AWS verification commands and cleanup invariant", async () => {
        const readme = await readFile(readmePath, "utf8");

        for (const expected of [
            "pnpm aws:preflight",
            "pnpm aws:inventory",
            "pnpm aws:check-idle",
            "pnpm aws:verify:earthquake-wrapper",
            "pnpm aws:verify:source-archiver",
            "pnpm aws:smoke:earthquake-manual",
            "pnpm aws:smoke:membership-manual",
            "source_archive_summary",
            "source_archive_status",
            "evidence_manifest_uri",
            "evidence_manifest_hash",
            "evidence_manifest_artifact_s3_key",
            "relayer_digest",
            "disaster_event_object_id",
            "pnpm aws:post-deploy-guardrails",
            "infra/aws/sonari-verifier-runner/docs/smoke-runbook.md",
            "Earthquake manual smoke の実行ノウハウ",
            "cleanup",
            "ASG desired capacity を `0`",
            "SSM `--parameters commands=...` shorthand を使わない",
            "JSON parameters file",
            "SSM Online は bootstrap 完了ではありません",
        ]) {
            expect(readme).toContain(expected);
        }
    });

    it("records AGENTS guidance to prefer scripts/aws for AWS testing", async () => {
        const agents = await readFile(agentsPath, "utf8");

        expect(agents).toContain("scripts/aws/README.md");
        expect(agents).toContain("AWS 関連テスト");
        expect(agents).toContain("SSM `--parameters commands=...` shorthand");
        expect(agents).toContain("SSM Online");
        expect(agents).toContain("bootstrap 完了");
    });
});
