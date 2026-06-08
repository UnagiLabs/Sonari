import { normalizeStructTag } from "@mysten/sui/utils";

/**
 * Pure, client-injected on-chain lookup of the connected wallet's
 * `MembershipPass` SBT. The identity page derives `membership_id` from this
 * instead of asking the member to paste an object id by hand.
 *
 * The Sui client is injected (rather than imported) so this stays unit-testable
 * with a stub client. Follows the client-injection + discriminated-union error
 * shape used by `dapp/app/claim/affected-cells-proof.ts`.
 */

/** Minimal owned-object shape we depend on from `SuiGrpcClient.listOwnedObjects`. */
export interface OwnedObjectSummary {
    readonly objectId: string;
    readonly type: string;
}

/** Minimal client surface: only the `listOwnedObjects` read we use. */
export interface OwnedObjectsClient {
    listOwnedObjects(options: {
        owner: string;
        type?: string;
        limit?: number;
    }): Promise<{ objects: readonly OwnedObjectSummary[] }>;
}

/**
 * Discriminated result of the lookup. `multiple` is treated as an anomaly:
 * the contract enforces one pass per wallet (`EMembershipPassAlreadyIssued` in
 * contracts/sources/membership.move), so we surface it rather than guess which
 * pass to bind (auto-picking the first risks a wrong identity binding).
 */
export type MembershipLookupResult =
    | { readonly kind: "ok"; readonly membershipId: string }
    | { readonly kind: "none" }
    | { readonly kind: "multiple"; readonly count: number }
    | { readonly kind: "error"; readonly message: string };

// One wallet should own exactly one MembershipPass; a small ceiling still lets
// us detect (and refuse to silently pick from) the anomalous multi-pass case.
const MEMBERSHIP_LOOKUP_LIMIT = 10;

/** Builds the fully-qualified `MembershipPass` Move type for `packageId`. */
export function membershipPassType(packageId: string): string {
    const trimmed = packageId.trim();
    if (trimmed.length === 0) {
        throw new Error("Membership package id is not configured.");
    }
    return `${trimmed}::membership::MembershipPass`;
}

export async function lookupMembershipPass(
    client: OwnedObjectsClient,
    owner: string,
    packageId: string,
): Promise<MembershipLookupResult> {
    let expectedType: string;
    let normalizedExpected: string;
    try {
        expectedType = membershipPassType(packageId);
        normalizedExpected = normalizeStructTag(expectedType);
    } catch (error) {
        return {
            kind: "error",
            message:
                error instanceof Error ? error.message : "Membership package id is not configured.",
        };
    }

    const trimmedOwner = owner.trim();
    if (trimmedOwner.length === 0) {
        return { kind: "error", message: "Connect a wallet to look up your Membership SBT." };
    }

    let objects: readonly OwnedObjectSummary[];
    try {
        const response = await client.listOwnedObjects({
            owner: trimmedOwner,
            type: expectedType,
            limit: MEMBERSHIP_LOOKUP_LIMIT,
        });
        objects = response.objects;
    } catch (error) {
        return {
            kind: "error",
            message:
                error instanceof Error ? error.message : "Could not look up your Membership SBT.",
        };
    }

    // Defense in depth: the server `type` filter already narrows results, but we
    // re-check by normalized struct tag so address-padding differences between
    // the env package id and the node's echoed type never cause a false match.
    const matches = objects.filter((object) =>
        typeMatchesMembershipPass(object.type, normalizedExpected),
    );

    const [first] = matches;
    if (matches.length === 0 || first === undefined) {
        return { kind: "none" };
    }
    if (matches.length > 1) {
        return { kind: "multiple", count: matches.length };
    }
    return { kind: "ok", membershipId: first.objectId };
}

function typeMatchesMembershipPass(actualType: string, normalizedExpected: string): boolean {
    try {
        return normalizeStructTag(actualType) === normalizedExpected;
    } catch {
        return false;
    }
}
