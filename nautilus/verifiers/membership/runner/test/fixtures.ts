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
            idkit_response: {
                protocol_version: "4.0",
                nonce: "nonce-123",
                action: "sonari_membership_register_v1",
                environment: "staging",
                responses: [
                    {
                        identifier: "orb",
                        signal_hash:
                            "0x004c584cd5e136507a762e7bc3bdd3f2e2535f5d32a7c6f343e17377886cca47",
                        proof: "0xproof",
                        merkle_root: "987654321",
                        nullifier: "12345678901234567890",
                    },
                ],
            },
        },
    };
}
