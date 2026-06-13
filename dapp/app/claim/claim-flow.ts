export type ClaimFlowAction = "claim";

export interface ClaimFlowCompleted {
    readonly claim: boolean;
}

export interface ClaimFlowInput {
    readonly proofReady: boolean;
    readonly proofRequired: boolean;
    readonly walletConnected: boolean;
    readonly txObjectsReady: boolean;
    readonly worldIdReady: boolean;
    readonly worldIdRequired: boolean;
    readonly claimable: boolean;
    readonly inFlight: boolean;
    readonly completed: ClaimFlowCompleted;
}

export interface ClaimFlowActionView {
    readonly action: ClaimFlowAction;
    readonly disabled: boolean;
    readonly completed: boolean;
}

const actionOrder: readonly ClaimFlowAction[] = ["claim"];

export function emptyClaimFlowCompleted(): ClaimFlowCompleted {
    return { claim: false };
}

export function buildClaimFlowActions(input: ClaimFlowInput): readonly ClaimFlowActionView[] {
    return actionOrder.map((action) => ({
        action,
        completed: input.completed[action],
        disabled: isClaimFlowActionDisabled(action, input),
    }));
}

export function isClaimFlowActionDisabled(
    action: ClaimFlowAction,
    input: ClaimFlowInput,
): boolean {
    if (
        input.inFlight ||
        input.completed[action] ||
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
