import type { ClientWithCoreApi } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import { describe, expect, it, vi } from "vitest";
import {
    SponsoredMembershipTransactionError,
    executeSponsoredMembershipTransaction,
} from "./sponsored-membership-transaction";

const SENDER = `0x${"11".repeat(32)}`;

function makeTransaction(): Transaction {
    const tx = new Transaction();
    tx.setSender(SENDER);
    tx.splitCoins(tx.gas, [tx.pure.u64(1n)]);
    return tx;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { "content-type": "application/json" },
    });
}

describe("executeSponsoredMembershipTransaction", () => {
    it("builds transaction kind bytes, sponsors, signs sponsored bytes, and executes", async () => {
        const calls: Array<{ url: string; body: unknown }> = [];
        const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? "null")) as unknown;
            calls.push({ url: String(url), body });

            if (String(url) === "/api/enoki/membership/sponsor") {
                return jsonResponse({ digest: "9WLwYUF4DQ3sVDzj5aJU32Bpc9gnk7Qx8xPiCXbUsc6", bytes: "c3BvbnNvcmVk" });
            }
            if (String(url) === "/api/enoki/membership/execute") {
                return jsonResponse({ digest: "executed-digest" });
            }
            throw new Error(`unexpected url ${String(url)}`);
        });
        const signTransaction = vi.fn(async (args: { transaction: string }) => {
            expect(args).toEqual({ transaction: "c3BvbnNvcmVk" });
            return { bytes: "signed-bytes", signature: "signed-signature" };
        });

        const result = await executeSponsoredMembershipTransaction({
            client: {} as ClientWithCoreApi,
            transaction: makeTransaction(),
            sender: SENDER,
            signer: { signTransaction },
            fetchImpl,
        });

        expect(result).toEqual({ digest: "executed-digest" });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(signTransaction).toHaveBeenCalledTimes(1);
        expect(calls).toHaveLength(2);
        expect(calls[0]?.url).toBe("/api/enoki/membership/sponsor");
        expect(calls[0]?.body).toMatchObject({ sender: SENDER });
        const transactionBlockKindBytes = (calls[0]?.body as { transactionBlockKindBytes?: unknown })
            .transactionBlockKindBytes;
        expect(typeof transactionBlockKindBytes).toBe("string");
        expect(fromBase64(transactionBlockKindBytes as string).length).toBeGreaterThan(0);
        expect(calls[1]).toEqual({
            url: "/api/enoki/membership/execute",
            body: {
                digest: "9WLwYUF4DQ3sVDzj5aJU32Bpc9gnk7Qx8xPiCXbUsc6",
                signature: "signed-signature",
            },
        });
    });

    it("sends only sender and transactionBlockKindBytes to the sponsor API", async () => {
        const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>;
            if (String(url) === "/api/enoki/membership/sponsor") {
                expect(Object.keys(body).sort()).toEqual(["sender", "transactionBlockKindBytes"]);
            }
            return jsonResponse({ digest: "9WLwYUF4DQ3sVDzj5aJU32Bpc9gnk7Qx8xPiCXbUsc6", bytes: "c3BvbnNvcmVk" });
        });
        const signTransaction = vi.fn(async () => ({
            bytes: "signed-bytes",
            signature: "signed-signature",
        }));

        await executeSponsoredMembershipTransaction({
            client: {} as ClientWithCoreApi,
            transaction: makeTransaction(),
            sender: SENDER,
            signer: { signTransaction },
            fetchImpl,
        });
    });

    it("encodes Transaction.build onlyTransactionKind bytes as base64", async () => {
        const tx = makeTransaction();
        const expectedKindBytes = toBase64(
            await tx.build({ client: {} as ClientWithCoreApi, onlyTransactionKind: true }),
        );
        let actualKindBytes = "";
        const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? "null")) as {
                transactionBlockKindBytes?: string;
            };
            if (String(url) === "/api/enoki/membership/sponsor") {
                actualKindBytes = body.transactionBlockKindBytes ?? "";
                return jsonResponse({ digest: "9WLwYUF4DQ3sVDzj5aJU32Bpc9gnk7Qx8xPiCXbUsc6", bytes: "c3BvbnNvcmVk" });
            }
            return jsonResponse({ digest: "executed-digest" });
        });

        await executeSponsoredMembershipTransaction({
            client: {} as ClientWithCoreApi,
            transaction: tx,
            sender: SENDER,
            signer: {
                signTransaction: async () => ({
                    bytes: "signed-bytes",
                    signature: "signed-signature",
                }),
            },
            fetchImpl,
        });

        expect(actualKindBytes).toBe(expectedKindBytes);
    });

    it("maps sponsor API failures to a retryable error before signing", async () => {
        const signTransaction = vi.fn(async () => ({
            bytes: "signed-bytes",
            signature: "signed-signature",
        }));

        await expect(
            executeSponsoredMembershipTransaction({
                client: {} as ClientWithCoreApi,
                transaction: makeTransaction(),
                sender: SENDER,
                signer: { signTransaction },
                fetchImpl: async () =>
                    jsonResponse(
                        { error: { code: "enoki_sponsorship_failed", message: "try again" } },
                        { status: 502 },
                    ),
            }),
        ).rejects.toSatisfy((error: unknown) => {
            return (
                error instanceof SponsoredMembershipTransactionError &&
                error.stage === "sponsor" &&
                error.message === "try again"
            );
        });
        expect(signTransaction).not.toHaveBeenCalled();
    });

    it("maps wallet signing failures to the sign stage", async () => {
        await expect(
            executeSponsoredMembershipTransaction({
                client: {} as ClientWithCoreApi,
                transaction: makeTransaction(),
                sender: SENDER,
                signer: {
                    signTransaction: async () => {
                        throw new Error("user rejected");
                    },
                },
                fetchImpl: async () =>
                    jsonResponse({ digest: "9WLwYUF4DQ3sVDzj5aJU32Bpc9gnk7Qx8xPiCXbUsc6", bytes: "c3BvbnNvcmVk" }),
            }),
        ).rejects.toSatisfy((error: unknown) => {
            return (
                error instanceof SponsoredMembershipTransactionError &&
                error.stage === "sign" &&
                error.message.includes("user rejected")
            );
        });
    });

    it("maps execute API failures to the execute stage", async () => {
        await expect(
            executeSponsoredMembershipTransaction({
                client: {} as ClientWithCoreApi,
                transaction: makeTransaction(),
                sender: SENDER,
                signer: {
                    signTransaction: async () => ({
                        bytes: "signed-bytes",
                        signature: "signed-signature",
                    }),
                },
                fetchImpl: async (url: string | URL | Request) => {
                    if (String(url) === "/api/enoki/membership/sponsor") {
                        return jsonResponse({
                            digest: "9WLwYUF4DQ3sVDzj5aJU32Bpc9gnk7Qx8xPiCXbUsc6",
                            bytes: "c3BvbnNvcmVk",
                        });
                    }
                    return jsonResponse(
                        { error: { code: "enoki_execute_failed", message: "execute failed" } },
                        { status: 502 },
                    );
                },
            }),
        ).rejects.toSatisfy((error: unknown) => {
            return (
                error instanceof SponsoredMembershipTransactionError &&
                error.stage === "execute" &&
                error.message === "execute failed"
            );
        });
    });

    it("rejects malformed sponsor responses", async () => {
        await expect(
            executeSponsoredMembershipTransaction({
                client: {} as ClientWithCoreApi,
                transaction: makeTransaction(),
                sender: SENDER,
                signer: {
                    signTransaction: async () => ({
                        bytes: "signed-bytes",
                        signature: "signed-signature",
                    }),
                },
                fetchImpl: async () => jsonResponse({ digest: "", bytes: "" }),
            }),
        ).rejects.toSatisfy((error: unknown) => {
            return (
                error instanceof SponsoredMembershipTransactionError &&
                error.stage === "sponsor"
            );
        });
    });
});
