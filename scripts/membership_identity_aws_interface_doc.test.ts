import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const membershipReadmePath = path.join(process.cwd(), "nautilus/verifiers/membership/README.md");
const teeReadmePath = path.join(process.cwd(), "nautilus/verifiers/membership/tee/README.md");
const awsReadmePath = path.join(process.cwd(), "infra/aws/membership-identity-runner/README.md");

async function readDocs(): Promise<{
    awsReadme: string;
    membershipReadme: string;
    teeReadme: string;
}> {
    const [awsReadme, membershipReadme, teeReadme] = await Promise.all([
        readFile(awsReadmePath, "utf8"),
        readFile(membershipReadmePath, "utf8"),
        readFile(teeReadmePath, "utf8"),
    ]);
    return { awsReadme, membershipReadme, teeReadme };
}

describe("membership identity AWS interface docs", () => {
    it("freezes the membership TEE stdin/stdout and status contract", async () => {
        const { membershipReadme, teeReadme } = await readDocs();
        const combined = `${membershipReadme}\n${teeReadme}`;

        expect(combined).toContain("1 request = 1 JSON in / 1 JSON out");
        expect(combined).toContain("stateless");
        expect(combined).toContain("IdentityVerifyRequest");
        expect(combined).toContain("IdentityTeeResult");

        for (const status of ["verified", "rejected", "pending_source", "unsupported"]) {
            expect(combined).toContain(`\`${status}\``);
        }

        expect(combined).toContain('status: "verified"');
        expect(combined).toContain("payload_bcs_hex");
        expect(combined).toContain("signature");
        expect(combined).toContain("public_key");
        expect(combined).toContain("非 verified stdout は `status` と `error_code` だけ");
        expect(combined).toContain("`pending_source` は earthquake と同じ");
    });

    it("freezes the AWS-facing env interface separately from World ID runtime config", async () => {
        const { membershipReadme, teeReadme } = await readDocs();
        const combined = `${membershipReadme}\n${teeReadme}`;

        for (const envName of [
            "SONARI_TEE_SIGNING_KEY_SEED",
            "SONARI_TEE_SIGNING_KEY_SEED_FILE",
            "SONARI_WORLD_ID_API_BASE",
        ]) {
            expect(combined).toContain(envName);
        }

        expect(combined).toContain("AWS 境界 interface");
        expect(combined).toContain("SONARI_WORLD_ID_APP_ID");
        expect(combined).toContain("runtime config");
        expect(combined).toContain("KMS");
        expect(combined).toContain("Nitro attestation");
        expect(combined).toContain("JSON 契約は変えない");
    });

    it("freezes the AWS on-demand job model and trust boundaries", async () => {
        const { awsReadme, membershipReadme } = await readDocs();

        expect(membershipReadme).toContain("infra/aws/membership-identity-runner/README.md");

        for (const phrase of [
            "SubmitVerification Lambda",
            "verification_jobs DynamoDB",
            "BatchVerifier Lambda",
            "Step Functions",
            "EC2 + Nitro",
        ]) {
            expect(awsReadme).toContain(phrase);
        }

        expect(awsReadme).toContain(
            "SubmitVerification Lambda -> verification_jobs DynamoDB -> BatchVerifier Lambda -> Step Functions -> EC2 + Nitro",
        );
        expect(awsReadme).toContain("TEE 境界契約");
        expect(awsReadme).toContain("#74");
        expect(awsReadme).toContain("AWS resource はこの issue では作らない");
        expect(awsReadme).toContain("worker は request 作成と状態管理");
        expect(awsReadme).toContain("TEE は検証、正規化、署名");
        expect(awsReadme).toContain("relayer は結果を配送するだけ");
    });

    it("freezes the membership identity TEE artifact build design", async () => {
        const { awsReadme } = await readDocs();

        for (const phrase of [
            "scripts/build_aws_earthquake_tee_artifact.ts",
            "scripts/build_aws_membership_identity_tee_artifact.ts",
            "nautilus/verifiers/membership/tee/Cargo.toml",
            "x86_64-unknown-linux-musl",
            "dist/aws/membership-identity-tee-artifact.tar.gz",
            ".sha256",
            "bin/membership-tee production",
        ]) {
            expect(awsReadme).toContain(phrase);
        }

        expect(awsReadme).toContain("Walrus CLI を含めない");
        expect(awsReadme).toContain("membership TEE は Walrus を呼ばない");
        expect(awsReadme).toContain("Nitro Enclave image 化は後続");
        expect(awsReadme).toContain("stdin/stdout 契約は変えない");
    });
});
