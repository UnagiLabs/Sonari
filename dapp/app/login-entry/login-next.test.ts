import { describe, expect, it } from "vitest";
import {
    DEFAULT_LOGIN_NEXT,
    buildLoginEntryHref,
    consumeLoginNext,
    sanitizeLoginNext,
    saveLoginNext,
} from "./login-next";

class FakeStorage implements Storage {
    private readonly values = new Map<string, string>();

    get length(): number {
        return this.values.size;
    }

    clear(): void {
        this.values.clear();
    }

    getItem(key: string): string | null {
        return this.values.get(key) ?? null;
    }

    key(index: number): string | null {
        return Array.from(this.values.keys())[index] ?? null;
    }

    removeItem(key: string): void {
        this.values.delete(key);
    }

    setItem(key: string, value: string): void {
        this.values.set(key, value);
    }
}

describe("sanitizeLoginNext", () => {
    it("uses /register as the default next path", () => {
        expect(DEFAULT_LOGIN_NEXT).toBe("/register");
        expect(sanitizeLoginNext(null)).toBe(DEFAULT_LOGIN_NEXT);
        expect(sanitizeLoginNext("")).toBe(DEFAULT_LOGIN_NEXT);
        expect(sanitizeLoginNext("   ")).toBe(DEFAULT_LOGIN_NEXT);
    });

    it("preserves safe relative paths with query strings", () => {
        expect(sanitizeLoginNext("/register")).toBe("/register");
        expect(sanitizeLoginNext("/claim/foo?step=1&x=2")).toBe(
            "/claim/foo?step=1&x=2",
        );
    });

    it("rejects unsafe or non-relative values", () => {
        expect(sanitizeLoginNext("claim/foo")).toBe(DEFAULT_LOGIN_NEXT);
        expect(sanitizeLoginNext("http://example.com/register")).toBe(DEFAULT_LOGIN_NEXT);
        expect(sanitizeLoginNext("https://example.com/register")).toBe(DEFAULT_LOGIN_NEXT);
        expect(sanitizeLoginNext("//example.com/register")).toBe(DEFAULT_LOGIN_NEXT);
        expect(sanitizeLoginNext("javascript:alert(1)")).toBe(DEFAULT_LOGIN_NEXT);
    });

    it("treats / as the default to avoid login loops", () => {
        expect(sanitizeLoginNext("/")).toBe(DEFAULT_LOGIN_NEXT);
    });
});

describe("buildLoginEntryHref", () => {
    it("encodes the whole next path and query as the next value", () => {
        expect(buildLoginEntryHref("/claim/foo?step=1&x=2")).toBe(
            "/?next=%2Fclaim%2Ffoo%3Fstep%3D1%26x%3D2",
        );
    });

    it("sanitizes unsafe next values before building the href", () => {
        expect(buildLoginEntryHref("https://example.com/claim")).toBe(
            "/?next=%2Fregister",
        );
    });
});

describe("login next storage helpers", () => {
    it("saves sanitized values and consumes them once", () => {
        const storage = new FakeStorage();

        saveLoginNext(storage, "/claim/foo?step=1&x=2");

        expect(consumeLoginNext(storage)).toBe("/claim/foo?step=1&x=2");
        expect(consumeLoginNext(storage)).toBeNull();
    });

    it("stores the default for unsafe values", () => {
        const storage = new FakeStorage();

        saveLoginNext(storage, "//example.com/claim");

        expect(consumeLoginNext(storage)).toBe(DEFAULT_LOGIN_NEXT);
    });
});
