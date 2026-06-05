import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const membershipReadmePath = path.join(process.cwd(), "nautilus/verifiers/membership/README.md");
const teeReadmePath = path.join(process.cwd(), "nautilus/verifiers/membership/tee/README.md");
const awsReadmePath = path.join(process.cwd(), "infra/aws/membership-identity-runner/README.md");
const awsEvidenceTemplatePath = path.join(
    process.cwd(),
    "infra/aws/membership-identity-runner/evidence-template.md",
);

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
        expect(combined).toContain("deploy config");
        expect(combined).toContain("TEE process env");
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
        expect(awsReadme).toContain("信頼境界");
        expect(awsReadme).toContain("#74");
        expect(awsReadme).toContain("運用 runbook");
        expect(awsReadme).toContain("Credential がない場合、この issue は close できません");
        expect(awsReadme).toContain("worker は request 作成と状態管理");
        expect(awsReadme).toContain("TEE は検証、正規化、署名");
        expect(awsReadme).toContain("relayer は結果を配送するだけ");
        expect(awsReadme).toContain("SONARI_WORLD_ID_APP_ID");
        expect(awsReadme).toContain("deploy config");
        expect(awsReadme).toContain("TEE process env");
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
            "bin/membership-tee server",
        ]) {
            expect(awsReadme).toContain(phrase);
        }

        expect(awsReadme).not.toContain("bin/membership-tee production");
        expect(awsReadme).toContain("Walrus CLI を含めません");
        expect(awsReadme).toContain("membership TEE は Walrus を呼びません");
        expect(awsReadme).toContain("membership-identity-tee.eif");
        expect(awsReadme).toContain("KMS / Nitro attestation measurement");
        expect(awsReadme).toContain("stdin/stdout 契約は変えません");
    });

    it("documents server as the AWS/Nautilus production path and production as legacy local stdio", async () => {
        const { awsReadme, membershipReadme, teeReadme } = await readDocs();
        const combined = `${awsReadme}\n${membershipReadme}\n${teeReadme}`;

        for (const phrase of [
            "AWS / Nautilus production entrypoint",
            "`membership-tee server`",
            "`membership-tee production` は legacy/local",
            "legacy/local stdin/stdout",
            "enclave-local ephemeral key",
            "/get_attestation",
            "/process_data",
            "registration metadata",
            "egress_proxy_url",
            "SONARI_WORLD_ID_EGRESS_PROXY_URL",
            "https://developer.world.org",
        ]) {
            expect(combined).toContain(phrase);
        }

        expect(combined).toContain(
            "World ID API base は canonical value を使い、egress は `egress_proxy_url` / `SONARI_WORLD_ID_EGRESS_PROXY_URL` で渡す",
        );
        expect(awsReadme).not.toContain("dummy proof mode");
        expect(awsReadme).not.toContain("dummy World ID verifier");
    });

    it("keeps unsupported KYC error code documentation aligned with the TEE", async () => {
        const { teeReadme } = await readDocs();

        expect(teeReadme).toContain("KYC_UNSUPPORTED");
        expect(teeReadme).not.toContain("KYC_NOT_IMPLEMENTED");
    });

    it("documents the operator runbook and evidence capture terms for issue 74 step 6", async () => {
        const [{ awsReadme }, awsEvidenceTemplate] = await Promise.all([
            readDocs(),
            readFile(awsEvidenceTemplatePath, "utf8"),
        ]);
        const combined = `${awsReadme}\n${awsEvidenceTemplate}`;

        for (const phrase of [
            "運用 runbook",
            "必須 artifact",
            "membership-identity-tee-artifact.tar.gz",
            "membership-identity-tee.eif",
            "KMS / Nitro attestation measurement",
            "ImageSha384",
            "PCR3",
            "encrypted signing material",
            "World ID app / proof input",
            "Stack parameter",
            "Sui object ID",
            "Local unit test",
            "AWS deployment smoke",
            "Nitro Enclave start",
            "vsock-proxy World ID real API smoke",
            "Sui dry-run",
            "Sui submit",
            "Post-tx membership pass state readback",
            "Credential がない場合、この issue は close できません",
            "Stack name:",
            "Artifact checksum:",
            "EIF identity:",
            "Public key:",
            "Tx digest:",
            "Post-tx readback:",
        ]) {
            expect(combined).toContain(phrase);
        }
    });
});
