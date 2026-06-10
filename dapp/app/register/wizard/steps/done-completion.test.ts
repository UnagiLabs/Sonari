import { describe, expect, it } from "vitest";
import { deriveDoneCompletion, type DoneCompletionView } from "./done-completion";

describe("deriveDoneCompletion", () => {
    it("membershipIssued と residenceSaved の両方が true なら complete を返す", () => {
        const result = deriveDoneCompletion(true, true);
        expect(result).toEqual<DoneCompletionView>({ kind: "complete" });
    });

    it("residenceSaved が false なら residence が pendingSteps に含まれる", () => {
        const result = deriveDoneCompletion(true, false);
        expect(result.kind).toBe("incomplete");
        if (result.kind === "incomplete") {
            expect(result.pendingSteps).toContain("residence");
            expect(result.pendingSteps).not.toContain("membership");
        }
    });

    it("membershipIssued が false なら membership が pendingSteps に含まれる", () => {
        const result = deriveDoneCompletion(false, true);
        expect(result.kind).toBe("incomplete");
        if (result.kind === "incomplete") {
            expect(result.pendingSteps).toContain("membership");
            expect(result.pendingSteps).not.toContain("residence");
        }
    });

    it("両方 false なら residence と membership の両方が pendingSteps に含まれる", () => {
        const result = deriveDoneCompletion(false, false);
        expect(result.kind).toBe("incomplete");
        if (result.kind === "incomplete") {
            expect(result.pendingSteps).toContain("residence");
            expect(result.pendingSteps).toContain("membership");
        }
    });

    it("residence は membership より先に pendingSteps に現れる（ウィザード順序）", () => {
        const result = deriveDoneCompletion(false, false);
        expect(result.kind).toBe("incomplete");
        if (result.kind === "incomplete") {
            const residenceIdx = result.pendingSteps.indexOf("residence");
            const membershipIdx = result.pendingSteps.indexOf("membership");
            expect(residenceIdx).toBeLessThan(membershipIdx);
        }
    });
});
