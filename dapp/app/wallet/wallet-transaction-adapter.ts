import type { Transaction } from "@mysten/sui/transactions";

export interface WalletExecuteResult {
    readonly $kind: string;
    readonly Transaction?: { readonly digest: string } | null | undefined;
    readonly FailedTransaction?: { readonly digest: string } | null | undefined;
}

export interface WalletTransactionExecutor {
    signAndExecuteTransaction(args: { transaction: Transaction }): Promise<WalletExecuteResult>;
}

export interface WalletTransactionSuccess {
    readonly digest: string;
}

export class WalletTransactionError extends Error {
    readonly digest?: string | undefined;

    constructor(message: string, digest?: string | undefined) {
        super(message);
        this.name = "WalletTransactionError";
        this.digest = digest;
    }
}

export async function executeWalletTransaction(
    executor: WalletTransactionExecutor,
    input: { readonly transaction: Transaction },
): Promise<WalletTransactionSuccess> {
    let result: WalletExecuteResult;

    try {
        result = await executor.signAndExecuteTransaction({ transaction: input.transaction });
    } catch (err) {
        const message = err instanceof Error ? err.message : "Wallet transaction failed.";
        throw new WalletTransactionError(message);
    }

    if (result.$kind !== "Transaction" || result.Transaction == null) {
        throw new WalletTransactionError(
            "The transaction was not executed successfully.",
            result.FailedTransaction?.digest ?? undefined,
        );
    }

    const digest = result.Transaction.digest;

    if (typeof digest !== "string" || digest.length === 0) {
        throw new WalletTransactionError("The executed transaction has no digest.");
    }

    return { digest };
}
