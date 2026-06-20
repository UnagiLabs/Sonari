import { describe, expect, it } from "vitest";
import {
    buildClaimFlowActions,
    isClaimFlowActionDisabled,
    type ClaimFlowInput,
} from "./claim-flow";

function input(overrides: Partial<ClaimFlowInput> = {}): ClaimFlowInput {
    return {
        proofReady: true,
        walletConnected: true,
        accountVerified: true,
        txObjectsReady: true,
        claimable: true,
        inFlight: false,
        ...overrides,
    };
}

describe("buildClaimFlowActions", () => {
    it("exposes a single claim action", () => {
        expect(buildClaimFlowActions(input())).toEqual([
            { action: "claim", disabled: false, completed: false },
        ]);
    });

    it("requires affected-cell proof before claiming", () => {
        expect(isClaimFlowActionDisabled("claim", input({ proofReady: false }))).toBe(true);
    });

    it("disables claim when there is nothing to receive or a transaction is in flight", () => {
        expect(isClaimFlowActionDisabled("claim", input({ claimable: false }))).toBe(true);
        expect(isClaimFlowActionDisabled("claim", input({ inFlight: true }))).toBe(true);
    });

    it("requires a verified MembershipPass account", () => {
        expect(isClaimFlowActionDisabled("claim", input({ accountVerified: false }))).toBe(true);
    });
});
