import { describe, expect, it } from "vitest";
import type { IdentityVerificationResult } from "./index.js";

describe("IdentityVerificationResult", () => {
    it("matches the target signed identity result shape", () => {
        const result = {
            intent: "SONARI_IDENTITY_VERIFICATION_V1",
            verifier_family: "identity",
            verifier_version: 1,
            registry_id: "0xregistry",
            membership_id: "0xmembership",
            owner: "0xowner",
            provider: "world_id",
            verified: true,
            duplicate_key_hash: "0xduplicate",
            evidence_hash: "0xevidence",
            issued_at_ms: 1_000,
            expires_at_ms: 2_000,
            terms_version: 1,
            signed_statement_hash: "0xstatement",
        } satisfies IdentityVerificationResult;

        expect(result.verified).toBe(true);
        expect(result.verifier_family).toBe("identity");
    });
});
