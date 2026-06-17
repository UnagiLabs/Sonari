export type MembershipIssueSubmittingPhase = "wallet" | "sponsor" | "sign" | "execute";

export type MembershipIssueViewState =
    | { readonly kind: "idle" }
    | { readonly kind: "submitting"; readonly phase: MembershipIssueSubmittingPhase }
    | { readonly kind: "failed"; readonly message: string };

export function membershipSubmittingMessageKey(phase: MembershipIssueSubmittingPhase): string {
    switch (phase) {
        case "wallet":
            return "issue.submitting";
        case "sponsor":
            return "issue.sponsoring";
        case "sign":
            return "issue.signing";
        case "execute":
            return "issue.executing";
    }
}
