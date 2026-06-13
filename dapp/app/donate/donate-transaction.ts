import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";

export interface DonateTransactionObjects {
    readonly pauseState: string;
    readonly donorRegistry: string;
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

export type DonatePassInput =
    | {
          readonly kind: "none";
      }
    | {
          readonly kind: "existing";
          readonly passId: string;
      };

export interface BuildDonateTransactionInput {
    readonly senderAddress?: string;
    readonly packageId: string;
    readonly usdcType: string;
    readonly amountMicroUsdc: bigint;
    readonly objects: DonateTransactionObjects;
    readonly destination: DonateDestinationInput;
    readonly donorPass: DonatePassInput;
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

    const pauseState = tx.object(input.objects.pauseState);
    const donorRegistry = tx.object(input.objects.donorRegistry);
    const donorPass =
        input.donorPass.kind === "none"
            ? tx.moveCall({
                  target: `${input.packageId}::accessor::issue_donor_pass`,
                  arguments: [pauseState, donorRegistry],
              })
            : tx.object(input.donorPass.passId);

    switch (input.destination.kind) {
        case "general": {
            tx.moveCall({
                target: `${input.packageId}::accessor::donate_general`,
                arguments: [
                    pauseState,
                    donorRegistry,
                    donorPass,
                    tx.object(input.objects.mainPool),
                    tx.object(input.objects.operationsPool),
                    usdc,
                ],
            });
            break;
        }
        case "campaign": {
            tx.moveCall({
                target: `${input.packageId}::accessor::donate_to_campaign`,
                arguments: [
                    pauseState,
                    donorRegistry,
                    donorPass,
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
                target: `${input.packageId}::accessor::donate_to_category`,
                arguments: [
                    pauseState,
                    donorRegistry,
                    donorPass,
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

    if (input.donorPass.kind === "none") {
        tx.moveCall({
            target: `${input.packageId}::accessor::transfer_donor_pass`,
            arguments: [donorPass],
        });
    }

    return { transaction: tx };
}
