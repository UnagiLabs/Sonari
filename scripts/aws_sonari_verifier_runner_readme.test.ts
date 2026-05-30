import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readmePath = path.join(process.cwd(), "infra/aws/sonari-verifier-runner/README.md");

async function readReadme(): Promise<string> {
    return readFile(readmePath, "utf8");
}

function expectContainsAll(source: string, expected: readonly string[]): void {
    for (const value of expected) {
        expect(source).toContain(value);
    }
}

describe("AWS Sonari verifier runner README", () => {
    it("documents manual deploy with the validated deploy plan and commit-scoped artifacts", async () => {
        const readme = await readReadme();

        expectContainsAll(readme, [
            "aws sts get-caller-identity",
            "595103996064",
            "pnpm build:aws-sonari-verifier-runner-lambda",
            "pnpm build:aws-earthquake-tee-artifact",
            "pnpm build:aws-membership-identity-tee-artifact",
            "pnpm build:aws-membership-identity-eif",
            "sonari-verifier-runner/<commit>/",
            "sonari-verifier-runner/$COMMIT_SHA/sonari-verifier-runner-lambda.zip",
            "sonari-verifier-runner/$COMMIT_SHA/earthquake-tee-artifact.tar.gz",
            "sonari-verifier-runner/$COMMIT_SHA/membership-identity-tee-artifact.tar.gz",
            "sonari-verifier-runner/$COMMIT_SHA/membership-identity-tee.eif",
            "scripts/aws_sonari_verifier_runner_deploy_plan.ts",
            "--relayer-network mainnet --world-id-proof-mode dummy",
            "parameterOverrideArgs",
            "aws cloudformation deploy",
            "--template-file infra/aws/sonari-verifier-runner/template.yaml",
            "ScheduleState=DISABLED",
        ]);
    });

    it("documents runtime smoke gates for both verifier kinds and idle resources", async () => {
        const readme = await readReadme();

        expectContainsAll(readme, [
            "earthquake manual workflow",
            "membership dummy proof smoke",
            "devnet or testnet only",
            "mainnet dummy proof is rejected before deploy",
            "unresolved CloudWatch log errors",
            "RunnerAutoScalingGroupName",
            "DesiredCapacity",
            "InService",
            "running EC2 instances: 0",
            "WatcherScheduleName",
            "BatchScheduleName",
            "DISABLED",
        ]);
    });

    it("limits old AWS-side cleanup to files after successful new-stack smoke", async () => {
        const readme = await readReadme();

        expectContainsAll(readme, [
            "Only after the new stack smoke succeeds",
            "resource inventory confirms idle",
            "old S3 prefixes",
            "old Lambda zip objects",
            "old TEE tarball objects",
            "old EIF objects",
            "old SHA objects",
            "Real old AWS stack deletion is a follow-up and out of scope",
        ]);
    });

    it("documents cost/resource checks and rollback without relying on the old stack", async () => {
        const readme = await readReadme();

        expectContainsAll(readme, [
            "Cost Explorer",
            "Cost Explorer can lag",
            "before deploy",
            "after cleanup",
            "running EC2",
            "ASG desired/running",
            "NAT gateways",
            "Elastic IPs",
            "load balancers",
            "EventBridge schedules",
            "CloudFormation stacks",
            "S3 inventory",
            "Rollback is Git revert plus redeploy",
        ]);
        expect(readme).not.toContain("rollback to earthquake-runner");
        expect(readme).not.toContain("rollback to membership-identity-runner");
    });

    it("does not document sensitive local material or static AWS keys", async () => {
        const readme = await readReadme();

        expect(readme).not.toMatch(/\bsecret/i);
        expect(readme).not.toContain(".local");
        expect(readme).not.toMatch(/private credential/i);
        expect(readme).not.toContain("AWS_ACCESS_KEY_ID");
        expect(readme).not.toContain("AWS_SECRET_ACCESS_KEY");
    });
});
