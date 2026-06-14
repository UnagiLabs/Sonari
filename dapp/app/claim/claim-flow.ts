export type ClaimFlowAction = "claim";

export interface ClaimFlowInput {
    readonly proofReady: boolean;
    readonly proofRequired: boolean;
    readonly walletConnected: boolean;
    readonly txObjectsReady: boolean;
    readonly worldIdReady: boolean;
    readonly worldIdRequired: boolean;
    readonly claimable: boolean;
    readonly inFlight: boolean;
}

export interface ClaimFlowActionView {
    readonly action: ClaimFlowAction;
    readonly disabled: boolean;
    readonly completed: boolean;
}

const actionOrder: readonly ClaimFlowAction[] = ["claim"];

export function buildClaimFlowActions(input: ClaimFlowInput): readonly ClaimFlowActionView[] {
    return actionOrder.map((action) => ({
        action,
        completed: false,
        disabled: isClaimFlowActionDisabled(action, input),
    }));
}

export function isClaimFlowActionDisabled(
    action: ClaimFlowAction,
    input: ClaimFlowInput,
): boolean {
    if (
        input.inFlight ||
        !input.walletConnected ||
        !input.txObjectsReady
    ) {
        return true;
    }

    switch (action) {
        case "claim":
            return (
                !input.claimable ||
                (input.proofRequired && !input.proofReady) ||
                (input.worldIdRequired && !input.worldIdReady)
            );
    }
}
