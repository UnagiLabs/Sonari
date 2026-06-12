import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";

export interface DonateTransactionObjects {
    readonly pauseState: string;
    readonly mainPool: string;
    readonly operationsPool: string;
}

export type DonateDestinationInput =
    | {
          readonly kind: "general";
      }
    | {
          readonly kind: "campaign";
          readonly campaignId: string;
      }
    | {
          readonly kind: "category";
          readonly categoryPoolId: string;
      };

export interface BuildDonateTransactionInput {
    readonly senderAddress?: string;
    readonly packageId: string;
    readonly usdcType: string;
    readonly amountMicroUsdc: bigint;
    readonly objects: DonateTransactionObjects;
    readonly destination: DonateDestinationInput;
    readonly clock?: string;
}

export interface BuildDonateTransactionResult {
    readonly transaction: Transaction;
}

export function buildDonateTransaction(input: BuildDonateTransactionInput): BuildDonateTransactionResult {
    const tx = new Transaction();
    if (input.senderAddress !== undefined) {
        tx.setSender(input.senderAddress);
    }

    const usdc = tx.coin({
        type: input.usdcType,
        balance: input.amountMicroUsdc,
        useGasCoin: false,
    });

    switch (input.destination.kind) {
        case "general": {
            tx.moveCall({
                target: `${input.packageId}::accessor::donate_general_split_usdc`,
                arguments: [
                    tx.object(input.objects.pauseState),
                    tx.object(input.objects.mainPool),
                    tx.object(input.objects.operationsPool),
                    usdc,
                ],
            });
            break;
        }
        case "campaign": {
            tx.moveCall({
                target: `${input.packageId}::accessor::donate_to_campaign_usdc`,
                arguments: [
                    tx.object(input.objects.pauseState),
                    tx.object(input.destination.campaignId),
                    tx.object(input.objects.mainPool),
                    tx.object(input.objects.operationsPool),
                    usdc,
                    tx.object(input.clock ?? SUI_CLOCK_OBJECT_ID),
                ],
            });
            break;
        }
        case "category": {
            tx.moveCall({
                target: `${input.packageId}::accessor::donate_to_category_usdc`,
                arguments: [
                    tx.object(input.objects.pauseState),
                    tx.object(input.destination.categoryPoolId),
                    tx.object(input.objects.mainPool),
                    tx.object(input.objects.operationsPool),
                    usdc,
                ],
            });
            break;
        }
        default: {
            const _exhaustive: never = input.destination;
            return _exhaustive;
        }
    }

    return { transaction: tx };
}
