export const DEFAULT_LOGIN_NEXT = "/register";

const LOGIN_NEXT_STORAGE_KEY = "sonari.login.next";

export type LoginNextStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export function sanitizeLoginNext(next: string | null | undefined): string {
    const value = next?.trim();
    if (!value || value === "/" || !value.startsWith("/") || value.startsWith("//")) {
        return DEFAULT_LOGIN_NEXT;
    }

    try {
        const parsed = new URL(value, "https://sonari.local");
        if (parsed.origin !== "https://sonari.local" || parsed.pathname === "/") {
            return DEFAULT_LOGIN_NEXT;
        }
    } catch {
        return DEFAULT_LOGIN_NEXT;
    }

    return value;
}

export function buildLoginEntryHref(next: string | null | undefined): string {
    const params = new URLSearchParams({
        next: sanitizeLoginNext(next),
    });

    return `/?${params.toString()}`;
}

export function saveLoginNext(
    storage: LoginNextStorage,
    next: string | null | undefined,
): void {
    storage.setItem(LOGIN_NEXT_STORAGE_KEY, sanitizeLoginNext(next));
}

export function consumeLoginNext(storage: LoginNextStorage): string | null {
    const next = storage.getItem(LOGIN_NEXT_STORAGE_KEY);
    storage.removeItem(LOGIN_NEXT_STORAGE_KEY);

    if (next === null) {
        return null;
    }

    return sanitizeLoginNext(next);
}
