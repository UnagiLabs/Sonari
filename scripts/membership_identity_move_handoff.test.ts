import { describe, expect, it } from "vitest";
import {
    buildIdentityMoveHandoff,
    parseIdentityMoveHandoffEnv,
} from "./membership_identity_move_handoff.js";

const env = {
    SONARI_IDENTITY_PACKAGE_ID: "0xabc",
    SONARI_IDENTITY_PAUSE_STATE_ID: "0x111",
    SONARI_IDENTITY_REGISTRY_ID: "0x222",
    SONARI_MEMBERSHIP_REGISTRY_ID: "0x333",
    SONARI_VERIFIER_REGISTRY_ID: "0x444",
    SONARI_MEMBERSHIP_PASS_ID: "0x555",
};

describe("membership identity Move handoff", () => {
    it("builds update_identity_verification call arguments from sidecar output", () => {
        const handoff = buildIdentityMoveHandoff(
            verifiedSidecarOutput(),
            parseIdentityMoveHandoffEnv(env),
        );

        expect(handoff.target).toBe("0xabc::accessor::update_identity_verification");
        expect(handoff.arguments).toEqual([
            "0x111",
            "0x222",
            "0x333",
            "0x444",
            "0x555",
            "0x6",
            [1, 2, 3],
            Array.from({ length: 64 }, () => 0x11),
            Array.from({ length: 32 }, () => 0x22),
        ]);
        expect(handoff.suiClientCall).toEqual([
            "sui",
            "client",
            "call",
            "--package",
            "0xabc",
            "--module",
            "accessor",
            "--function",
            "update_identity_verification",
            "--args",
            "0x111",
            "0x222",
            "0x333",
            "0x444",
            "0x555",
            "0x6",
            "[1,2,3]",
            `[${Array.from({ length: 64 }, () => 0x11).join(",")}]`,
            `[${Array.from({ length: 32 }, () => 0x22).join(",")}]`,
        ]);
    });

    it("fails closed when required localnet object ids are missing", () => {
        expect(() => parseIdentityMoveHandoffEnv({})).toThrow(
            "Missing required env: SONARI_IDENTITY_PACKAGE_ID",
        );
    });

    it("rejects non-verified sidecar output and malformed signature bytes", () => {
        expect(() =>
            buildIdentityMoveHandoff(
                { ok: true, result: { status: "rejected", error_code: "NOPE" } },
                parseIdentityMoveHandoffEnv(env),
            ),
        ).toThrow("verified identity sidecar output");

        expect(() =>
            buildIdentityMoveHandoff(
                {
                    ok: true,
                    result: {
                        status: "verified",
                        payload_bcs_hex: "0x01",
                        signature: `0x${"11".repeat(63)}`,
                        public_key: `0x${"22".repeat(32)}`,
                    },
                },
                parseIdentityMoveHandoffEnv(env),
            ),
        ).toThrow("signature must be 64 bytes");
    });
});

function verifiedSidecarOutput(): unknown {
    return {
        ok: true,
        result: {
            status: "verified",
            payload_bcs_hex: "0x010203",
            signature: `0x${"11".repeat(64)}`,
            public_key: `0x${"22".repeat(32)}`,
        },
    };
}
