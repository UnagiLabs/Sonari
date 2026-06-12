export type ClaimFlowAction = "submit" | "verify" | "floor" | "payout";

export interface ClaimFlowCompleted {
    readonly submit: boolean;
    readonly verify: boolean;
    readonly floor: boolean;
    readonly payout: boolean;
}

export interface ClaimFlowInput {
    readonly proofReady: boolean;
    readonly walletConnected: boolean;
    readonly txObjectsReady: boolean;
    readonly worldIdReady: boolean;
    readonly claimWindowOpen: boolean;
    readonly floorClaimAvailable: boolean;
    readonly payoutFinalized: boolean;
    readonly inFlight: boolean;
    readonly completed: ClaimFlowCompleted;
}

export interface ClaimFlowActionView {
    readonly action: ClaimFlowAction;
    readonly disabled: boolean;
    readonly completed: boolean;
}

const actionOrder: readonly ClaimFlowAction[] = ["submit", "verify", "floor", "payout"];

export function emptyClaimFlowCompleted(): ClaimFlowCompleted {
    return { submit: false, verify: false, floor: false, payout: false };
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
        case "submit":
            return !input.proofReady || !input.claimWindowOpen;
        case "verify":
            return !input.completed.submit || !input.worldIdReady;
        case "floor":
            return !input.completed.verify || !input.floorClaimAvailable || !input.worldIdReady;
        case "payout":
            return !input.completed.verify || !input.payoutFinalized;
    }
}
