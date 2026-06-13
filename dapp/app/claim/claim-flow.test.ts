import { describe, expect, it } from "vitest";
import {
    buildClaimFlowActions,
    emptyClaimFlowCompleted,
    isClaimFlowActionDisabled,
    type ClaimFlowInput,
} from "./claim-flow";

function input(overrides: Partial<ClaimFlowInput> = {}): ClaimFlowInput {
    return {
        proofReady: true,
        proofRequired: true,
        walletConnected: true,
        txObjectsReady: true,
        worldIdReady: true,
        worldIdRequired: true,
        claimable: true,
        inFlight: false,
        completed: emptyClaimFlowCompleted(),
        ...overrides,
    };
}

describe("buildClaimFlowActions", () => {
    it("exposes a single claim action", () => {
        expect(buildClaimFlowActions(input())).toEqual([
            { action: "claim", disabled: false, completed: false },
        ]);
    });

    it("requires affected-cell proof only when the claim path needs it", () => {
        expect(isClaimFlowActionDisabled("claim", input({ proofReady: false }))).toBe(true);
        expect(
            isClaimFlowActionDisabled(
                "claim",
                input({ proofRequired: false, proofReady: false }),
            ),
        ).toBe(false);
    });

    it("requires World ID material only when the claim path needs it", () => {
        expect(isClaimFlowActionDisabled("claim", input({ worldIdReady: false }))).toBe(true);
        expect(
            isClaimFlowActionDisabled(
                "claim",
                input({ worldIdRequired: false, worldIdReady: false }),
            ),
        ).toBe(false);
    });

    it("disables claim when there is nothing to receive or a transaction is in flight", () => {
        expect(isClaimFlowActionDisabled("claim", input({ claimable: false }))).toBe(true);
        expect(isClaimFlowActionDisabled("claim", input({ inFlight: true }))).toBe(true);
        expect(
            isClaimFlowActionDisabled(
                "claim",
                input({ completed: { claim: true } }),
            ),
        ).toBe(true);
    });
});
