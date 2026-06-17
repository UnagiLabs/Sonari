import { describe, expect, it } from "vitest";
import {
    membershipIssueFailureMessageKey,
    membershipSubmittingMessageKey,
    type MembershipIssueFailureStage,
    type MembershipIssueSubmittingPhase,
} from "./membership-issue-state";

describe("membershipSubmittingMessageKey", () => {
    it.each<[MembershipIssueSubmittingPhase, string]>([
        ["prepare", "issue.preparing"],
        ["sponsor", "issue.sponsoring"],
        ["sign", "issue.signing"],
        ["execute", "issue.executing"],
    ])("maps %s phase to %s", (phase, expectedKey) => {
        expect(membershipSubmittingMessageKey(phase)).toBe(expectedKey);
    });
});

describe("membershipIssueFailureMessageKey", () => {
    it.each<[MembershipIssueFailureStage, string]>([
        ["build", "issue.prepareFailed"],
        ["sponsor", "issue.sponsorFailed"],
        ["sign", "issue.signatureRejected"],
        ["execute", "issue.executeFailed"],
    ])("maps %s failure to %s", (stage, expectedKey) => {
        expect(membershipIssueFailureMessageKey(stage)).toBe(expectedKey);
    });
});
