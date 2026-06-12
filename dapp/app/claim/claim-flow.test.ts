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
        walletConnected: true,
        txObjectsReady: true,
        worldIdReady: true,
        claimWindowOpen: true,
        floorClaimAvailable: true,
        payoutFinalized: false,
        inFlight: false,
        completed: emptyClaimFlowCompleted(),
        ...overrides,
    };
}

describe("buildClaimFlowActions", () => {
    it("enables only submit before the affected-cell proof has been submitted", () => {
        expect(
            buildClaimFlowActions(input()).map((action) => [action.action, action.disabled]),
        ).toEqual([
            ["submit", false],
            ["verify", true],
            ["floor", true],
            ["payout", true],
        ]);
    });

    it("enables verify after submit when World ID material is ready", () => {
        const state = input({ completed: { ...emptyClaimFlowCompleted(), submit: true } });

        expect(isClaimFlowActionDisabled("verify", state)).toBe(false);
        expect(isClaimFlowActionDisabled("floor", state)).toBe(true);
    });

    it("fails closed when World ID material is missing", () => {
        const state = input({
            worldIdReady: false,
            completed: { ...emptyClaimFlowCompleted(), submit: true, verify: true },
        });

        expect(isClaimFlowActionDisabled("verify", state)).toBe(true);
        expect(isClaimFlowActionDisabled("floor", state)).toBe(true);
    });

    it("gates floor and payout on census and floor-budget state", () => {
        const verified = { ...emptyClaimFlowCompleted(), submit: true, verify: true };

        expect(
            isClaimFlowActionDisabled(
                "floor",
                input({ floorClaimAvailable: true, payoutFinalized: false, completed: verified }),
            ),
        ).toBe(false);
        expect(
            isClaimFlowActionDisabled(
                "payout",
                input({ floorClaimAvailable: true, payoutFinalized: false, completed: verified }),
            ),
        ).toBe(true);

        expect(
            isClaimFlowActionDisabled(
                "floor",
                input({ floorClaimAvailable: false, payoutFinalized: true, completed: verified }),
            ),
        ).toBe(true);
        expect(
            isClaimFlowActionDisabled(
                "payout",
                input({ floorClaimAvailable: false, payoutFinalized: true, completed: verified }),
            ),
        ).toBe(false);
    });

    it("disables every action while a transaction is in flight", () => {
        expect(
            buildClaimFlowActions(input({ inFlight: true })).every((action) => action.disabled),
        ).toBe(true);
    });
});
