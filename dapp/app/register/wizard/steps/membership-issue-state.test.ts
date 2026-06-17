import { describe, expect, it } from "vitest";
import {
    membershipSubmittingMessageKey,
    type MembershipIssueSubmittingPhase,
} from "./membership-issue-state";

describe("membershipSubmittingMessageKey", () => {
    it.each<[MembershipIssueSubmittingPhase, string]>([
        ["sponsor", "issue.sponsoring"],
        ["sign", "issue.signing"],
        ["execute", "issue.executing"],
    ])("maps %s phase to %s", (phase, expectedKey) => {
        expect(membershipSubmittingMessageKey(phase)).toBe(expectedKey);
    });
});
