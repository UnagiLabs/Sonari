import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface IdentityResultVectors {
    readonly schema: "sonari.identity_verification_result.bcs";
    readonly version: 1;
    readonly signing_policy: IdentityResultSigningPolicy;
    readonly vectors: readonly IdentityResultVector[];
}

interface IdentityResultSigningPolicy {
    readonly verified_true_is_signable: true;
    readonly verified_false_is_signable: false;
    readonly unsigned_statuses_must_not_include: readonly [
        "payload_bcs_hex",
        "signature",
        "public_key",
    ];
}

interface IdentityResultVector {
    readonly case_id: string;
    readonly payload_bcs_hex: string;
    readonly signature_hex?: string;
    readonly public_key_hex?: string;
}

const repoRoot = process.cwd();

describe("identity payload golden vectors", () => {
    it("pins the vector metadata and signing policy", () => {
        const vectors = readIdentityResultVectors();

        expect(vectors.schema).toBe("sonari.identity_verification_result.bcs");
        expect(vectors.version).toBe(1);
        expect(vectors.signing_policy).toEqual({
            verified_true_is_signable: true,
            verified_false_is_signable: false,
            unsigned_statuses_must_not_include: ["payload_bcs_hex", "signature", "public_key"],
        });
    });

    it("keeps the Move decode fixture aligned with the canonical vector", () => {
        const moveSource = readText("contracts/tests/identity_result_tests.move");
        const vector = readVector("world_id_success_v1");

        expect(extractMoveHexLiteral(moveSource, "identity_result_bcs")).toBe(
            hexWithoutPrefix(vector.payload_bcs_hex),
        );
    });

    it("keeps the Move signed verification fixture aligned with the vector", () => {
        const moveSource = readText("contracts/tests/identity_verification_tests.move");
        const vector = readVector("move_signed_world_id_fixture_v1");

        expect(extractMoveHexLiteral(moveSource, "rust_fixture_payload_bcs")).toBe(
            hexWithoutPrefix(vector.payload_bcs_hex),
        );
        expect(extractMoveHexLiteral(moveSource, "rust_fixture_signature")).toBe(
            hexWithoutPrefix(requiredHex(vector.signature_hex, "signature_hex")),
        );
        expect(extractMoveHexLiteral(moveSource, "rust_fixture_public_key")).toBe(
            hexWithoutPrefix(requiredHex(vector.public_key_hex, "public_key_hex")),
        );
    });
});

function readVector(caseId: string): IdentityResultVector {
    const vectors = readIdentityResultVectors();
    const vector = vectors.vectors.find((candidate) => candidate.case_id === caseId);
    if (vector === undefined) {
        throw new Error(`Missing identity result vector: ${caseId}`);
    }
    return vector;
}

function readIdentityResultVectors(): IdentityResultVectors {
    return JSON.parse(
        readText("schemas/examples/identity_result_vectors.json"),
    ) as IdentityResultVectors;
}

function extractMoveHexLiteral(source: string, functionName: string): string {
    const pattern = new RegExp(
        `fun\\s+${functionName}\\s*\\([^)]*\\)\\s*:\\s*vector<u8>\\s*{\\s*x"([0-9a-f]+)"\\s*}`,
    );
    const match = source.match(pattern);
    if (match?.[1] === undefined) {
        throw new Error(`Missing Move hex literal function: ${functionName}`);
    }
    return match[1];
}

function readText(filePath: string): string {
    return readFileSync(path.join(repoRoot, filePath), "utf8");
}

function requiredHex(value: string | undefined, field: string): string {
    if (value === undefined) {
        throw new Error(`Missing vector field: ${field}`);
    }
    return value;
}

function hexWithoutPrefix(value: string): string {
    const hex = value.startsWith("0x") ? value.slice(2) : value;
    if (!/^[0-9a-f]+$/.test(hex)) {
        throw new Error(`Invalid lowercase hex value: ${value}`);
    }
    return hex;
}
