export type MembershipIssueSubmittingPhase = "prepare" | "sponsor" | "sign" | "execute";
export type MembershipIssueFailureStage = "build" | "sponsor" | "sign" | "execute";

export type MembershipIssueViewState =
    | { readonly kind: "idle" }
    | { readonly kind: "submitting"; readonly phase: MembershipIssueSubmittingPhase }
    | { readonly kind: "failed"; readonly message: string };

export function membershipSubmittingMessageKey(phase: MembershipIssueSubmittingPhase): string {
    switch (phase) {
        case "prepare":
            return "issue.preparing";
        case "sponsor":
            return "issue.sponsoring";
        case "sign":
            return "issue.signing";
        case "execute":
            return "issue.executing";
    }
}

export function membershipIssueFailureMessageKey(stage: MembershipIssueFailureStage): string {
    switch (stage) {
        case "build":
            return "issue.prepareFailed";
        case "sponsor":
            return "issue.sponsorFailed";
        case "sign":
            return "issue.signatureRejected";
        case "execute":
            return "issue.executeFailed";
    }
}
