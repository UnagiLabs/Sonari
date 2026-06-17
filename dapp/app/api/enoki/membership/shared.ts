import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, isValidSuiAddress } from "@mysten/sui/utils";

export const ENOKI_MEMBERSHIP_MAX_TRANSACTION_KIND_BYTES = 16 * 1024;

export type EnokiMembershipErrorCode =
    | "invalid_request"
    | "invalid_sender"
    | "invalid_transaction_block_kind_bytes"
    | "empty_transaction_block_kind_bytes"
    | "transaction_block_kind_bytes_too_large"
    | "invalid_transaction_block_kind_bcs"
    | "missing_membership_move_call"
    | "disallowed_transaction_command"
    | "disallowed_move_call_target"
    | "unsupported_network"
    | "missing_enoki_private_api_key"
    | "invalid_membership_package_id";

export interface EnokiMembershipError {
    readonly code: EnokiMembershipErrorCode;
    readonly message: string;
}

export type EnokiMembershipResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: EnokiMembershipError };

export interface EnokiMembershipConfig {
    readonly enokiPrivateApiKey: string;
    readonly network: "testnet";
    readonly membershipPackageId: string;
    readonly allowedMoveCallTargets: ReadonlySet<string>;
}

export interface EnokiMembershipRequest {
    readonly sender: string;
    readonly transactionBlockKindBytes: string;
    readonly decodedTransactionBlockKindBytes: Uint8Array;
}

export type EnokiMembershipConfigResult =
    | { readonly ok: true; readonly config: EnokiMembershipConfig }
    | { readonly ok: false; readonly error: EnokiMembershipError };

export type EnokiMembershipRequestResult =
    | { readonly ok: true; readonly request: EnokiMembershipRequest }
    | { readonly ok: false; readonly error: EnokiMembershipError };

export function readEnokiMembershipConfig(): EnokiMembershipConfigResult {
    const network = process.env.NEXT_PUBLIC_SUI_NETWORK;
    if (network !== "testnet") {
        return err("unsupported_network", "Enoki membership sponsorship is only enabled on testnet.");
    }

    const enokiPrivateApiKey = process.env.ENOKI_PRIVATE_API_KEY;
    if (enokiPrivateApiKey === undefined || enokiPrivateApiKey.trim().length === 0) {
        return err("missing_enoki_private_api_key", "Enoki sponsorship is not configured.");
    }

    const membershipPackageId = process.env.NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID;
    if (membershipPackageId === undefined || !isValidSuiAddress(membershipPackageId)) {
        return err("invalid_membership_package_id", "Membership package id is invalid.");
    }

    return {
        ok: true,
        config: {
            enokiPrivateApiKey,
            network,
            membershipPackageId,
            allowedMoveCallTargets: membershipAllowlist(membershipPackageId),
        },
    };
}

export function parseEnokiMembershipRequest(
    body: unknown,
    membershipPackageId: string,
): EnokiMembershipRequestResult {
    const record = expectRecord(body);
    if (!record.ok) {
        return record;
    }

    const sender = record.value.sender;
    if (typeof sender !== "string" || !isValidSuiAddress(sender)) {
        return err("invalid_sender", "sender must be a Sui address.");
    }

    const encodedKindBytes = record.value.transactionBlockKindBytes;
    if (typeof encodedKindBytes !== "string" || !isBase64(encodedKindBytes)) {
        return err(
            "invalid_transaction_block_kind_bytes",
            "transactionBlockKindBytes must be base64.",
        );
    }

    const decodedKindBytes = fromBase64(encodedKindBytes);
    if (decodedKindBytes.length === 0) {
        return err(
            "empty_transaction_block_kind_bytes",
            "transactionBlockKindBytes must not decode to an empty payload.",
        );
    }
    if (decodedKindBytes.length > ENOKI_MEMBERSHIP_MAX_TRANSACTION_KIND_BYTES) {
        return err(
            "transaction_block_kind_bytes_too_large",
            `transactionBlockKindBytes must decode to at most ${ENOKI_MEMBERSHIP_MAX_TRANSACTION_KIND_BYTES} bytes.`,
        );
    }

    const allowlist = membershipAllowlist(membershipPackageId);
    const validation = validateTransactionKind(decodedKindBytes, allowlist);
    if (!validation.ok) {
        return validation;
    }

    return {
        ok: true,
        request: {
            sender,
            transactionBlockKindBytes: encodedKindBytes,
            decodedTransactionBlockKindBytes: decodedKindBytes,
        },
    };
}

function validateTransactionKind(
    decodedKindBytes: Uint8Array,
    allowlist: ReadonlySet<string>,
): EnokiMembershipResult<undefined> {
    let data: unknown;
    try {
        data = Transaction.fromKind(decodedKindBytes).getData();
    } catch {
        return err("invalid_transaction_block_kind_bcs", "transactionBlockKindBytes is not a valid transaction kind.");
    }

    const commands = readCommands(data);
    if (!commands.ok) {
        return commands;
    }

    let hasMoveCall = false;
    for (const command of commands.value) {
        const kind = commandKind(command);
        if (kind !== "MoveCall" && kind !== "MakeMoveVec") {
            return err(
                "disallowed_transaction_command",
                "transactionBlockKindBytes contains a disallowed transaction command.",
            );
        }

        const target = moveCallTarget(command);
        if (target !== null) {
            hasMoveCall = true;
        }
        if (target !== null && !allowlist.has(target)) {
            return err("disallowed_move_call_target", "transactionBlockKindBytes contains a disallowed Move call target.");
        }
    }

    if (!hasMoveCall) {
        return err("missing_membership_move_call", "transactionBlockKindBytes must contain a MembershipPass Move call.");
    }

    return { ok: true, value: undefined };
}

function membershipAllowlist(membershipPackageId: string): ReadonlySet<string> {
    return new Set([
        `${membershipPackageId}::accessor::register_member`,
        `${membershipPackageId}::accessor::new_residence_proof_step_left`,
        `${membershipPackageId}::accessor::new_residence_proof_step_right`,
    ]);
}

function expectRecord(body: unknown): EnokiMembershipResult<Record<string, unknown>> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return err("invalid_request", "Request body must be an object.");
    }
    return { ok: true, value: body as Record<string, unknown> };
}

function readCommands(data: unknown): EnokiMembershipResult<readonly unknown[]> {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return err("invalid_transaction_block_kind_bcs", "transaction kind data is invalid.");
    }
    const commands = (data as Record<string, unknown>).commands;
    if (!Array.isArray(commands)) {
        return err("invalid_transaction_block_kind_bcs", "transaction kind commands are invalid.");
    }
    return { ok: true, value: commands };
}

function commandKind(command: unknown): string | null {
    if (typeof command !== "object" || command === null || Array.isArray(command)) {
        return null;
    }
    const kind = (command as Record<string, unknown>).$kind;
    return typeof kind === "string" ? kind : null;
}

function moveCallTarget(command: unknown): string | null {
    if (typeof command !== "object" || command === null || Array.isArray(command)) {
        return null;
    }
    const record = command as Record<string, unknown>;
    if (record.$kind !== "MoveCall" || typeof record.MoveCall !== "object" || record.MoveCall === null) {
        return null;
    }

    const moveCall = record.MoveCall as Record<string, unknown>;
    if (
        typeof moveCall.package !== "string" ||
        typeof moveCall.module !== "string" ||
        typeof moveCall.function !== "string"
    ) {
        return "";
    }

    return `${moveCall.package}::${moveCall.module}::${moveCall.function}`;
}

function isBase64(value: string): boolean {
    if (value.length % 4 !== 0) {
        return false;
    }
    return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value);
}

function err(
    code: EnokiMembershipErrorCode,
    message: string,
): { readonly ok: false; readonly error: EnokiMembershipError } {
    return { ok: false, error: { code, message } };
}
