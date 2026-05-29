import { createHash } from "node:crypto";

export type IdentityProvider = "kyc" | "world_id";

export const IDENTITY_RESULT_INTENT = "SONARI_IDENTITY_VERIFICATION_V1";

export const IDENTITY_RESULT_FIELD_ORDER = [
    "intent",
    "verifier_family",
    "verifier_version",
    "registry_id",
    "membership_id",
    "owner",
    "provider",
    "verified",
    "duplicate_key_hash",
    "evidence_hash",
    "issued_at_ms",
    "expires_at_ms",
    "terms_version",
    "signed_statement_hash",
] as const;

export const IDENTITY_PROVIDER_BCS = {
    kyc: 1,
    world_id: 2,
} as const satisfies Record<IdentityProvider, number>;

export type IdentityResultField = (typeof IDENTITY_RESULT_FIELD_ORDER)[number];

export interface IdentityEvidenceSnapshot {
    readonly provider: IdentityProvider;
    readonly membership_id: string;
    readonly owner: string;
    readonly evidence_hash: string;
    readonly submitted_at_ms: number;
}

export interface IdentityVerificationResult {
    readonly intent: string;
    readonly verifier_family: "identity";
    readonly verifier_version: number;
    readonly registry_id: string;
    readonly membership_id: string;
    readonly owner: string;
    readonly provider: IdentityProvider;
    readonly verified: boolean;
    readonly duplicate_key_hash: string;
    readonly evidence_hash: string;
    readonly issued_at_ms: number;
    readonly expires_at_ms: number;
    readonly terms_version: number;
    readonly signed_statement_hash: string;
}

export function encodeIdentityVerificationResultBcsHex(input: unknown): string {
    const result = parseIdentityVerificationResult(input);
    const bytes = [
        ...encodeBytes(utf8Bytes(result.intent)),
        ...encodeBytes(utf8Bytes(result.verifier_family)),
        ...encodeU64(result.verifier_version),
        ...parseBytes32(result.registry_id, "registry_id"),
        ...parseBytes32(result.membership_id, "membership_id"),
        ...parseBytes32(result.owner, "owner"),
        IDENTITY_PROVIDER_BCS[result.provider],
        result.verified ? 1 : 0,
        ...parseBytes32(result.duplicate_key_hash, "duplicate_key_hash"),
        ...parseBytes32(result.evidence_hash, "evidence_hash"),
        ...encodeU64(result.issued_at_ms),
        ...encodeU64(result.expires_at_ms),
        ...encodeU64(result.terms_version),
        ...parseBytes32(result.signed_statement_hash, "signed_statement_hash"),
    ];

    return `0x${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function parseIdentityVerificationResult(input: unknown): IdentityVerificationResult {
    if (!isRecord(input)) {
        throw new Error("Identity verification result must be an object");
    }

    const unexpectedKey = Object.keys(input).find(
        (key) => !IDENTITY_RESULT_FIELD_ORDER.includes(key as IdentityResultField),
    );
    if (unexpectedKey !== undefined) {
        throw new Error(`Unexpected identity result field: ${unexpectedKey}`);
    }

    const result = {
        intent: parseIdentityResultIntent(input.intent),
        verifier_family: parseVerifierFamily(input.verifier_family),
        verifier_version: parseU64(input.verifier_version, "verifier_version"),
        registry_id: parseHexString(input.registry_id, "registry_id"),
        membership_id: parseHexString(input.membership_id, "membership_id"),
        owner: parseHexString(input.owner, "owner"),
        provider: parseIdentityProvider(input.provider),
        verified: parseBoolean(input.verified, "verified"),
        duplicate_key_hash: parseHexString(input.duplicate_key_hash, "duplicate_key_hash"),
        evidence_hash: parseHexString(input.evidence_hash, "evidence_hash"),
        issued_at_ms: parseU64(input.issued_at_ms, "issued_at_ms"),
        expires_at_ms: parseU64(input.expires_at_ms, "expires_at_ms"),
        terms_version: parseU64(input.terms_version, "terms_version"),
        signed_statement_hash: parseHexString(input.signed_statement_hash, "signed_statement_hash"),
    };

    parseBytes32(result.registry_id, "registry_id");
    parseBytes32(result.membership_id, "membership_id");
    parseBytes32(result.owner, "owner");
    parseBytes32(result.duplicate_key_hash, "duplicate_key_hash");
    parseBytes32(result.evidence_hash, "evidence_hash");
    parseBytes32(result.signed_statement_hash, "signed_statement_hash");

    return result;
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function parseIdentityResultIntent(value: unknown): typeof IDENTITY_RESULT_INTENT {
    if (value !== IDENTITY_RESULT_INTENT) {
        throw new Error(`intent must be ${IDENTITY_RESULT_INTENT}`);
    }
    return value;
}

function parseVerifierFamily(value: unknown): "identity" {
    if (value !== "identity") {
        throw new Error("verifier_family must be identity");
    }
    return value;
}

function parseIdentityProvider(value: unknown): IdentityProvider {
    if (value !== "kyc" && value !== "world_id") {
        throw new Error("provider must be kyc or world_id");
    }
    return value;
}

function parseBoolean(value: unknown, field: string): boolean {
    if (typeof value !== "boolean") {
        throw new Error(`${field} must be a boolean`);
    }
    return value;
}

function parseU64(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${field} must be a safe unsigned integer`);
    }
    return value;
}

function parseHexString(value: unknown, field: string): string {
    if (typeof value !== "string") {
        throw new Error(`${field} must be a 0x-prefixed hex string`);
    }
    return value;
}

function parseBytes32(value: string, field: string): number[] {
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error(`${field} must be a 32-byte 0x-prefixed hex string`);
    }

    const hex = value.slice(2);
    const bytes: number[] = [];
    for (let offset = 0; offset < hex.length; offset += 2) {
        bytes.push(Number.parseInt(hex.slice(offset, offset + 2), 16));
    }
    return bytes;
}

function utf8Bytes(value: string): number[] {
    const bytes: number[] = [];
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint === undefined) {
            continue;
        }
        if (codePoint <= 0x7f) {
            bytes.push(codePoint);
        } else if (codePoint <= 0x7ff) {
            bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
        } else if (codePoint <= 0xffff) {
            bytes.push(
                0xe0 | (codePoint >> 12),
                0x80 | ((codePoint >> 6) & 0x3f),
                0x80 | (codePoint & 0x3f),
            );
        } else {
            bytes.push(
                0xf0 | (codePoint >> 18),
                0x80 | ((codePoint >> 12) & 0x3f),
                0x80 | ((codePoint >> 6) & 0x3f),
                0x80 | (codePoint & 0x3f),
            );
        }
    }
    return bytes;
}

function encodeBytes(bytes: number[]): number[] {
    return [...encodeUleb128(bytes.length), ...bytes];
}

function encodeU64(value: number): number[] {
    let remaining = BigInt(value);
    const bytes: number[] = [];
    for (let index = 0; index < 8; index += 1) {
        bytes.push(Number(remaining & 0xffn));
        remaining >>= 8n;
    }
    return bytes;
}

function encodeUleb128(value: number): number[] {
    let remaining = value;
    const bytes: number[] = [];
    do {
        let byte = remaining & 0x7f;
        remaining >>= 7;
        if (remaining !== 0) {
            byte |= 0x80;
        }
        bytes.push(byte);
    } while (remaining !== 0);
    return bytes;
}

export interface MembershipIdentityState {
    readonly identity_verified: boolean;
    readonly identity_provider_mask: number;
    readonly identity_verified_at_ms: number;
    readonly identity_expires_at_ms: number;
    readonly terms_version: number;
    readonly signed_statement_hash: string;
}

export interface KycDuplicateKeyInput {
    readonly provider_id: string;
    readonly provider_user_unique_id: string;
}

export interface WorldIdDuplicateKeyInput {
    readonly world_app_id: string;
    readonly action: string;
    readonly nullifier: string;
}

export function computeKycDuplicateKeyHash(input: KycDuplicateKeyInput): string {
    return sha256Hex(
        joinDuplicateKeyParts(["sonari:kyc:v1", input.provider_id, input.provider_user_unique_id]),
    );
}

export function computeWorldIdDuplicateKeyHash(input: WorldIdDuplicateKeyInput): string {
    return sha256Hex(
        joinDuplicateKeyParts([
            "sonari:world_id:v1",
            input.world_app_id,
            input.action,
            canonicalWorldIdNullifier(input.nullifier),
        ]),
    );
}

export function canonicalWorldIdNullifier(nullifier: string): string {
    if (nullifier.length === 0 || nullifier.includes("\0")) {
        throw new Error(
            "World ID nullifier must be a non-empty decimal or 0x-prefixed hex string without NUL",
        );
    }
    if (/^0[xX][0-9a-fA-F]+$/.test(nullifier)) {
        return BigInt(nullifier).toString(10);
    }
    if (/^[0-9]+$/.test(nullifier)) {
        return BigInt(nullifier).toString(10);
    }
    throw new Error("World ID nullifier must be a decimal or 0x-prefixed hex string");
}

function joinDuplicateKeyParts(parts: readonly string[]): string {
    for (const part of parts) {
        if (part.length === 0 || part.includes("\0")) {
            throw new Error("duplicate key input parts must be non-empty strings without NUL");
        }
    }
    return parts.join("\0");
}

function sha256Hex(input: string): string {
    return `0x${createHash("sha256").update(input, "utf8").digest("hex")}`;
}
