export type DoneCompletionView =
    | { readonly kind: "complete" }
    | {
          readonly kind: "incomplete";
          readonly pendingSteps: readonly ("residence" | "membership")[];
      };

export function deriveDoneCompletion(
    membershipIssued: boolean,
    residenceSaved: boolean,
): DoneCompletionView {
    const pendingSteps: ("residence" | "membership")[] = [];
    if (!residenceSaved) pendingSteps.push("residence");
    if (!membershipIssued) pendingSteps.push("membership");
    if (pendingSteps.length === 0) return { kind: "complete" };
    return { kind: "incomplete", pendingSteps };
}
