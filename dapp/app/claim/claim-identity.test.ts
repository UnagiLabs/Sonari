import { describe, expect, it } from "vitest";
import {
    canonicalWorldIdNullifier,
    computeWorldIdDuplicateKeyHash,
    resolveWorldIdClaimIdentity,
    WORLD_IDENTITY_PROVIDER,
} from "./claim-identity";

describe("computeWorldIdDuplicateKeyHash", () => {
    it("matches the membership verifier World ID duplicate key vector", () => {
        expect(
            computeWorldIdDuplicateKeyHash({
                rpId: "rp_staging_123",
                action: "sonari_membership_register_v1",
                nullifier: "12345678901234567890",
            }),
        ).toBe("0xe0b489ec33cad56128dd39a060f165edc65c69f5c6dba23cd0b44d8dd4476878");
    });

    it("canonicalizes equivalent decimal and hex nullifier values", () => {
        expect(canonicalWorldIdNullifier("00012345678901234567890")).toBe(
            "12345678901234567890",
        );
        expect(canonicalWorldIdNullifier("0xAB54A98CEB1F0AD2")).toBe("12345678901234567890");
        expect(canonicalWorldIdNullifier("0XAB54A98CEB1F0AD2")).toBe("12345678901234567890");
    });

    it("rejects missing or malformed duplicate key inputs", () => {
        expect(() => canonicalWorldIdNullifier("")).toThrow(/World ID nullifier/);
        expect(() =>
            computeWorldIdDuplicateKeyHash({
                rpId: "",
                action: "sonari_membership_register_v1",
                nullifier: "1",
            }),
        ).toThrow(/duplicate key input parts/);
    });
});

describe("resolveWorldIdClaimIdentity", () => {
    it("returns identity provider and duplicate key hash from a valid IDKit response", () => {
        const result = resolveWorldIdClaimIdentity({
            rpId: "rp_staging_123",
            action: "sonari_membership_register_v1",
            idkitResponse: {
                responses: [{ nullifier: "0xAB54A98CEB1F0AD2" }],
            },
        });

        expect(result).toEqual({
            kind: "ok",
            identityProvider: WORLD_IDENTITY_PROVIDER,
            duplicateKeyHash:
                "0xe0b489ec33cad56128dd39a060f165edc65c69f5c6dba23cd0b44d8dd4476878",
        });
    });

    it("fails closed when World ID materials are missing", () => {
        expect(
            resolveWorldIdClaimIdentity({
                rpId: "",
                action: "sonari_membership_register_v1",
                idkitResponse: { responses: [{ nullifier: "1" }] },
            }),
        ).toEqual({ kind: "missing", reason: "world_id_config" });

        expect(
            resolveWorldIdClaimIdentity({
                rpId: "rp_staging_123",
                action: "sonari_membership_register_v1",
                idkitResponse: null,
            }),
        ).toEqual({ kind: "missing", reason: "world_id_nullifier" });
    });
});
