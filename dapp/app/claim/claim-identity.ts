import { sha256Hex } from "@sonari/proof-core";

export const WORLD_IDENTITY_PROVIDER = 2;

export interface WorldIdDuplicateKeyInput {
    readonly rpId: string;
    readonly action: string;
    readonly nullifier: string;
}

export interface ResolveWorldIdClaimIdentityInput {
    readonly rpId: string;
    readonly action: string;
    readonly idkitResponse: Record<string, unknown> | null;
}

export type WorldIdClaimIdentityResult =
    | {
          readonly kind: "ok";
          readonly identityProvider: typeof WORLD_IDENTITY_PROVIDER;
          readonly duplicateKeyHash: string;
      }
    | {
          readonly kind: "missing";
          readonly reason: "world_id_config" | "world_id_nullifier";
      };

export function computeWorldIdDuplicateKeyHash(input: WorldIdDuplicateKeyInput): string {
    return sha256Hex(
        new TextEncoder().encode(
            joinDuplicateKeyParts([
                "sonari:world_id:v2",
                input.rpId,
                input.action,
                canonicalWorldIdNullifier(input.nullifier),
            ]),
        ),
    );
}

export function canonicalWorldIdNullifier(nullifier: string): string {
    if (nullifier.length === 0 || nullifier.includes("\0")) {
        throw new Error(
            "World ID nullifier must be a non-empty decimal or 0x-prefixed hex string without NUL",
        );
    }
    if (/^0[xX][0-9a-fA-F]+$/u.test(nullifier)) {
        return BigInt(nullifier).toString(10);
    }
    if (/^[0-9]+$/u.test(nullifier)) {
        return BigInt(nullifier).toString(10);
    }
    throw new Error("World ID nullifier must be a decimal or 0x-prefixed hex string");
}

export function resolveWorldIdClaimIdentity(
    input: ResolveWorldIdClaimIdentityInput,
): WorldIdClaimIdentityResult {
    if (input.rpId.trim().length === 0 || input.action.trim().length === 0) {
        return { kind: "missing", reason: "world_id_config" };
    }

    const nullifier = readWorldIdNullifier(input.idkitResponse);
    if (nullifier === null) {
        return { kind: "missing", reason: "world_id_nullifier" };
    }

    try {
        return {
            kind: "ok",
            identityProvider: WORLD_IDENTITY_PROVIDER,
            duplicateKeyHash: computeWorldIdDuplicateKeyHash({
                rpId: input.rpId,
                action: input.action,
                nullifier,
            }),
        };
    } catch {
        return { kind: "missing", reason: "world_id_nullifier" };
    }
}

function readWorldIdNullifier(response: Record<string, unknown> | null): string | null {
    if (response === null || !Array.isArray(response.responses) || response.responses.length < 1) {
        return null;
    }
    const first = response.responses[0];
    if (!isRecord(first) || typeof first.nullifier !== "string" || first.nullifier.length === 0) {
        return null;
    }
    return first.nullifier;
}

function joinDuplicateKeyParts(parts: readonly string[]): string {
    for (const part of parts) {
        if (part.length === 0 || part.includes("\0")) {
            throw new Error("duplicate key input parts must be non-empty strings without NUL");
        }
    }
    return parts.join("\0");
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}
