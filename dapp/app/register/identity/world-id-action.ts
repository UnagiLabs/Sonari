const DEFAULT_WORLD_ID_ACTION = "sonari_membership_register_v2";
const WORLD_ID_ACTION_PATTERN = /^sonari_membership_register_v\d+$/;

export function resolveWorldIdAction(value = process.env.NEXT_PUBLIC_WORLD_ID_ACTION): string {
    const action = value?.trim();
    if (action === undefined || action.length === 0) {
        return DEFAULT_WORLD_ID_ACTION;
    }
    if (!WORLD_ID_ACTION_PATTERN.test(action)) {
        throw new Error("NEXT_PUBLIC_WORLD_ID_ACTION must match sonari_membership_register_v<N>");
    }
    return action;
}

export const WORLD_ID_ACTION = resolveWorldIdAction();
