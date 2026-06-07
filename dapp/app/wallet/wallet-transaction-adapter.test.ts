import { Transaction } from "@mysten/sui/transactions";
import { describe, expect, it } from "vitest";
import {
    WalletTransactionError,
    executeWalletTransaction,
} from "./wallet-transaction-adapter";

function makeTx(): Transaction {
    return new Transaction();
}

describe("executeWalletTransaction", () => {
    it("returns digest on success", async () => {
        const tx = makeTx();
        const calls: Array<{ transaction: Transaction }> = [];
        const executor = {
            signAndExecuteTransaction: async (args: { transaction: Transaction }) => {
                calls.push(args);
                return {
                    $kind: "Transaction" as const,
                    Transaction: { digest: "0xabc" },
                };
            },
        };

        const result = await executeWalletTransaction(executor, { transaction: tx });

        expect(result.digest).toBe("0xabc");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.transaction).toBe(tx);
    });

    it("throws WalletTransactionError when executor resolves FailedTransaction", async () => {
        const executor = {
            signAndExecuteTransaction: async (_args: { transaction: Transaction }) => ({
                $kind: "FailedTransaction" as const,
                FailedTransaction: { digest: "0xdef" },
            }),
        };

        await expect(
            executeWalletTransaction(executor, { transaction: makeTx() }),
        ).rejects.toThrow(WalletTransactionError);

        await expect(
            executeWalletTransaction(executor, { transaction: makeTx() }),
        ).rejects.toSatisfy((err: unknown) => {
            return err instanceof WalletTransactionError && err.digest === "0xdef";
        });
    });

    it("throws WalletTransactionError when executor rejects with an Error", async () => {
        const executor = {
            signAndExecuteTransaction: async (_args: { transaction: Transaction }) => {
                throw new Error("user rejected");
            },
        };

        await expect(
            executeWalletTransaction(executor, { transaction: makeTx() }),
        ).rejects.toSatisfy((err: unknown) => {
            return (
                err instanceof WalletTransactionError &&
                err.message.includes("user rejected")
            );
        });
    });

    it("throws WalletTransactionError when executor rejects with a non-Error value", async () => {
        const executor = {
            signAndExecuteTransaction: (_args: { transaction: Transaction }): Promise<never> =>
                Promise.reject("boom"),
        };

        await expect(
            executeWalletTransaction(executor, { transaction: makeTx() }),
        ).rejects.toThrow(WalletTransactionError);
    });

    it("throws WalletTransactionError when digest is empty string", async () => {
        const executor = {
            signAndExecuteTransaction: async (_args: { transaction: Transaction }) => ({
                $kind: "Transaction" as const,
                Transaction: { digest: "" },
            }),
        };

        await expect(
            executeWalletTransaction(executor, { transaction: makeTx() }),
        ).rejects.toThrow(WalletTransactionError);
    });

    it("has name WalletTransactionError on thrown error", async () => {
        const executor = {
            signAndExecuteTransaction: async (_args: { transaction: Transaction }) => ({
                $kind: "FailedTransaction" as const,
                FailedTransaction: { digest: "0xfail" },
            }),
        };

        await expect(
            executeWalletTransaction(executor, { transaction: makeTx() }),
        ).rejects.toSatisfy((err: unknown) => {
            return err instanceof WalletTransactionError && err.name === "WalletTransactionError";
        });
    });
});
