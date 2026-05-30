import type { IdentityVerifyRequest } from "../src/index.js";

export function validRequest(): IdentityVerifyRequest {
    return {
        registry_id: `0x${"11".repeat(32)}`,
        membership_id: `0x${"22".repeat(32)}`,
        owner: `0x${"33".repeat(32)}`,
        provider: "world_id",
        terms_version: 1,
        signed_statement_hash: `0x${"44".repeat(32)}`,
        world_id: {
            world_app_id: "app_staging_123",
            nullifier_hash: "12345678901234567890",
            merkle_root: "0xabc",
            proof: "0xproof",
            verification_level: "orb",
            action: "sonari_membership_register_v1",
            signal_hash: `0x${"55".repeat(32)}`,
        },
    };
}
