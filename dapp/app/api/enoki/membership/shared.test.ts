import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    ENOKI_MEMBERSHIP_MAX_TRANSACTION_KIND_BYTES,
    parseEnokiMembershipRequest,
    readEnokiMembershipConfig,
} from "./shared";

const PACKAGE_ID = `0x${"12".repeat(32)}`;
const SENDER = `0x${"34".repeat(32)}`;

const originalEnv = {
    ENOKI_PRIVATE_API_KEY: process.env.ENOKI_PRIVATE_API_KEY,
    SONARI_SUI_NETWORK: process.env.SONARI_SUI_NETWORK,
    NEXT_PUBLIC_SUI_NETWORK: process.env.NEXT_PUBLIC_SUI_NETWORK,
    NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID:
        process.env.NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID,
};

function restoreEnv(): void {
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
}

function configureEnv(): void {
    process.env.ENOKI_PRIVATE_API_KEY = "enoki-private-key";
    process.env.SONARI_SUI_NETWORK = "testnet";
    process.env.NEXT_PUBLIC_SUI_NETWORK = "mainnet";
    process.env.NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID = PACKAGE_ID;
}

async function buildKindBase64(targets: readonly string[]): Promise<string> {
    const tx = new Transaction();
    for (const target of targets) {
        tx.moveCall({ target, arguments: [] });
    }
    return toBase64(await tx.build({ onlyTransactionKind: true }));
}

function requestBody(transactionBlockKindBytes: string): unknown {
    return {
        sender: SENDER,
        transactionBlockKindBytes,
    };
}

describe("Enoki membership shared validation", () => {
    beforeEach(() => {
        configureEnv();
    });

    afterEach(() => {
        restoreEnv();
    });

    describe("readEnokiMembershipConfig", () => {
        it("reads the server-side network instead of the public network", () => {
            process.env.SONARI_SUI_NETWORK = "testnet";
            process.env.NEXT_PUBLIC_SUI_NETWORK = "mainnet";

            expect(readEnokiMembershipConfig()).toMatchObject({
                ok: true,
                config: { network: "testnet" },
            });
        });

        it("rejects missing server-side network", () => {
            delete process.env.SONARI_SUI_NETWORK;
            process.env.NEXT_PUBLIC_SUI_NETWORK = "testnet";

            expect(readEnokiMembershipConfig()).toMatchObject({
                ok: false,
                error: { code: "unsupported_network" },
            });
        });

        it("rejects non-testnet network", () => {
            process.env.SONARI_SUI_NETWORK = "mainnet";

            expect(readEnokiMembershipConfig()).toMatchObject({
                ok: false,
                error: { code: "unsupported_network" },
            });
        });

        it("returns a controlled error when ENOKI_PRIVATE_API_KEY is missing", () => {
            delete process.env.ENOKI_PRIVATE_API_KEY;

            expect(readEnokiMembershipConfig()).toMatchObject({
                ok: false,
                error: { code: "missing_enoki_private_api_key" },
            });
        });

        it("rejects invalid membership package id", () => {
            process.env.NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID = "not-a-package";

            expect(readEnokiMembershipConfig()).toMatchObject({
                ok: false,
                error: { code: "invalid_membership_package_id" },
            });
        });

        it("returns the MembershipPass allowlist for the configured package", () => {
            expect(readEnokiMembershipConfig()).toEqual({
                ok: true,
                config: {
                    enokiPrivateApiKey: "enoki-private-key",
                    network: "testnet",
                    membershipPackageId: PACKAGE_ID,
                    allowedMoveCallTargets: new Set([
                        `${PACKAGE_ID}::accessor::register_member`,
                        `${PACKAGE_ID}::accessor::new_residence_proof_step_left`,
                        `${PACKAGE_ID}::accessor::new_residence_proof_step_right`,
                    ]),
                },
            });
        });
    });

    describe("parseEnokiMembershipRequest", () => {
        it("rejects invalid sender", async () => {
            const kind = await buildKindBase64([`${PACKAGE_ID}::accessor::register_member`]);

            expect(
                parseEnokiMembershipRequest(
                    { sender: "not-an-address", transactionBlockKindBytes: kind },
                    PACKAGE_ID,
                ),
            ).toMatchObject({
                ok: false,
                error: { code: "invalid_sender" },
            });
        });

        it("rejects transactionBlockKindBytes that is not base64", () => {
            expect(parseEnokiMembershipRequest(requestBody("not base64!"), PACKAGE_ID)).toMatchObject(
                {
                    ok: false,
                    error: { code: "invalid_transaction_block_kind_bytes" },
                },
            );
        });

        it("rejects empty decoded kind bytes", () => {
            expect(parseEnokiMembershipRequest(requestBody(""), PACKAGE_ID)).toMatchObject({
                ok: false,
                error: { code: "empty_transaction_block_kind_bytes" },
            });
        });

        it("rejects decoded kind bytes above the max", () => {
            const bytes = new Uint8Array(ENOKI_MEMBERSHIP_MAX_TRANSACTION_KIND_BYTES + 1);

            expect(parseEnokiMembershipRequest(requestBody(toBase64(bytes)), PACKAGE_ID)).toMatchObject({
                ok: false,
                error: { code: "transaction_block_kind_bytes_too_large" },
            });
        });

        it("accepts the max decoded byte boundary before BCS validation", () => {
            const bytes = new Uint8Array(ENOKI_MEMBERSHIP_MAX_TRANSACTION_KIND_BYTES).fill(255);

            expect(parseEnokiMembershipRequest(requestBody(toBase64(bytes)), PACKAGE_ID)).toMatchObject({
                ok: false,
                error: { code: "invalid_transaction_block_kind_bcs" },
            });
        });

        it("rejects malformed BCS transaction kind bytes", () => {
            expect(parseEnokiMembershipRequest(requestBody(toBase64(new Uint8Array([255]))), PACKAGE_ID)).toMatchObject({
                ok: false,
                error: { code: "invalid_transaction_block_kind_bcs" },
            });
        });

        it("rejects Move calls outside the MembershipPass allowlist", async () => {
            const kind = await buildKindBase64([`${PACKAGE_ID}::accessor::delete_member`]);

            expect(parseEnokiMembershipRequest(requestBody(kind), PACKAGE_ID)).toMatchObject({
                ok: false,
                error: { code: "disallowed_move_call_target" },
            });
        });

        it("rejects non-Membership transaction commands", async () => {
            const tx = new Transaction();
            tx.splitCoins(tx.gas, [tx.pure.u64(1)]);
            const kind = toBase64(await tx.build({ onlyTransactionKind: true }));

            expect(parseEnokiMembershipRequest(requestBody(kind), PACKAGE_ID)).toMatchObject({
                ok: false,
                error: { code: "disallowed_transaction_command" },
            });
        });

        it("requires at least one MembershipPass Move call", async () => {
            const tx = new Transaction();
            tx.makeMoveVec({
                type: `${PACKAGE_ID}::allowed_residence_cell::ProofStep`,
                elements: [],
            });
            const kind = toBase64(await tx.build({ onlyTransactionKind: true }));

            expect(parseEnokiMembershipRequest(requestBody(kind), PACKAGE_ID)).toMatchObject({
                ok: false,
                error: { code: "missing_membership_move_call" },
            });
        });

        it("allows the three MembershipPass Move call targets", async () => {
            const kind = await buildKindBase64([
                `${PACKAGE_ID}::accessor::new_residence_proof_step_left`,
                `${PACKAGE_ID}::accessor::new_residence_proof_step_right`,
                `${PACKAGE_ID}::accessor::register_member`,
            ]);

            expect(parseEnokiMembershipRequest(requestBody(kind), PACKAGE_ID)).toMatchObject({
                ok: true,
                request: {
                    sender: SENDER,
                    transactionBlockKindBytes: kind,
                },
            });
        });

        it("allows non-MoveCall commands such as MakeMoveVec", async () => {
            const tx = new Transaction();
            const left = tx.moveCall({
                target: `${PACKAGE_ID}::accessor::new_residence_proof_step_left`,
                arguments: [],
            });
            tx.makeMoveVec({
                type: `${PACKAGE_ID}::allowed_residence_cell::ProofStep`,
                elements: [left],
            });
            const kind = toBase64(await tx.build({ onlyTransactionKind: true }));

            expect(parseEnokiMembershipRequest(requestBody(kind), PACKAGE_ID)).toMatchObject({
                ok: true,
            });
        });
    });
});
