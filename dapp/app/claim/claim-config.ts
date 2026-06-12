const DEFAULT_WORLD_ID_ACTION = "sonari_membership_register_v2";
const WORLD_ID_ACTION_PATTERN = /^sonari_membership_register_v\d+$/u;

export interface ClaimEnv {
    readonly NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID?: string | undefined;
    readonly NEXT_PUBLIC_SONARI_IDENTITY_PAUSE_STATE_ID?: string | undefined;
    readonly NEXT_PUBLIC_SONARI_MEMBERSHIP_REGISTRY_ID?: string | undefined;
    readonly NEXT_PUBLIC_SONARI_IDENTITY_REGISTRY_ID?: string | undefined;
    readonly NEXT_PUBLIC_WORLD_ID_RP_ID?: string | undefined;
    readonly NEXT_PUBLIC_WORLD_ID_ACTION?: string | undefined;
}

export interface ClaimConfig {
    readonly packageId: string;
    readonly pauseStateId: string;
    readonly membershipRegistryId: string;
    readonly identityRegistryId: string;
    readonly worldIdRpId: string;
    readonly worldIdAction: string;
}

export type ClaimConfigReadResult =
    | { readonly kind: "ok"; readonly config: ClaimConfig }
    | { readonly kind: "missing"; readonly fields: readonly string[] }
    | { readonly kind: "invalid"; readonly message: string };

export function readClaimConfig(env: ClaimEnv = readProcessClaimEnv()): ClaimConfigReadResult {
    const values = {
        NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID:
            env.NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID?.trim() ?? "",
        NEXT_PUBLIC_SONARI_IDENTITY_PAUSE_STATE_ID:
            env.NEXT_PUBLIC_SONARI_IDENTITY_PAUSE_STATE_ID?.trim() ?? "",
        NEXT_PUBLIC_SONARI_MEMBERSHIP_REGISTRY_ID:
            env.NEXT_PUBLIC_SONARI_MEMBERSHIP_REGISTRY_ID?.trim() ?? "",
        NEXT_PUBLIC_SONARI_IDENTITY_REGISTRY_ID:
            env.NEXT_PUBLIC_SONARI_IDENTITY_REGISTRY_ID?.trim() ?? "",
        NEXT_PUBLIC_WORLD_ID_RP_ID: env.NEXT_PUBLIC_WORLD_ID_RP_ID?.trim() ?? "",
    };

    const missing = Object.entries(values)
        .filter(([, value]) => value.length === 0)
        .map(([key]) => key);
    if (missing.length > 0) {
        return { kind: "missing", fields: missing };
    }

    for (const [key, value] of Object.entries(values)) {
        if (key === "NEXT_PUBLIC_WORLD_ID_RP_ID") {
            continue;
        }
        if (!isObjectId(value)) {
            return { kind: "invalid", message: `${key} must be a 32-byte object id.` };
        }
    }

    const action = resolveWorldIdAction(env.NEXT_PUBLIC_WORLD_ID_ACTION);
    if (action.kind === "invalid") {
        return action;
    }

    return {
        kind: "ok",
        config: {
            packageId: values.NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID,
            pauseStateId: values.NEXT_PUBLIC_SONARI_IDENTITY_PAUSE_STATE_ID,
            membershipRegistryId: values.NEXT_PUBLIC_SONARI_MEMBERSHIP_REGISTRY_ID,
            identityRegistryId: values.NEXT_PUBLIC_SONARI_IDENTITY_REGISTRY_ID,
            worldIdRpId: values.NEXT_PUBLIC_WORLD_ID_RP_ID,
            worldIdAction: action.value,
        },
    };
}

function readProcessClaimEnv(): ClaimEnv {
    return {
        NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID:
            process.env.NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID,
        NEXT_PUBLIC_SONARI_IDENTITY_PAUSE_STATE_ID:
            process.env.NEXT_PUBLIC_SONARI_IDENTITY_PAUSE_STATE_ID,
        NEXT_PUBLIC_SONARI_MEMBERSHIP_REGISTRY_ID:
            process.env.NEXT_PUBLIC_SONARI_MEMBERSHIP_REGISTRY_ID,
        NEXT_PUBLIC_SONARI_IDENTITY_REGISTRY_ID:
            process.env.NEXT_PUBLIC_SONARI_IDENTITY_REGISTRY_ID,
        NEXT_PUBLIC_WORLD_ID_RP_ID: process.env.NEXT_PUBLIC_WORLD_ID_RP_ID,
        NEXT_PUBLIC_WORLD_ID_ACTION: process.env.NEXT_PUBLIC_WORLD_ID_ACTION,
    };
}

function resolveWorldIdAction(
    value: string | undefined,
): { readonly kind: "ok"; readonly value: string } | { readonly kind: "invalid"; readonly message: string } {
    const action = value?.trim();
    if (action === undefined || action.length === 0) {
        return { kind: "ok", value: DEFAULT_WORLD_ID_ACTION };
    }
    if (!WORLD_ID_ACTION_PATTERN.test(action)) {
        return {
            kind: "invalid",
            message: "NEXT_PUBLIC_WORLD_ID_ACTION must match sonari_membership_register_v<N>",
        };
    }
    return { kind: "ok", value: action };
}

function isObjectId(value: string): boolean {
    return /^0x[0-9a-fA-F]{64}$/u.test(value);
}
