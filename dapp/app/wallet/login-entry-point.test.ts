import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "login-entry-point.tsx"), "utf8");

describe("LoginEntryPoint", () => {
    it("is a client component that reads wallet and route state", () => {
        expect(source.startsWith('"use client";')).toBe(true);
        expect(source).toContain('import { useCurrentAccount } from "@mysten/dapp-kit-react";');
        expect(source).toContain('import { usePathname, useSearchParams } from "next/navigation";');
        expect(source).toContain("const account = useCurrentAccount();");
        expect(source).toContain("const pathname = usePathname();");
        expect(source).toContain("const searchParams = useSearchParams();");
        expect(source).toContain('const t = useTranslations("wallet");');
    });

    it("keeps WalletConnect on root and after wallet connection", () => {
        expect(source).toMatch(/if\s*\(\s*pathname\s*===\s*"\/"\s*\|\|\s*account\s*\)\s*\{\s*return\s*<WalletConnect\s*\/>/s);
    });

    it("returns the login link branch whenever account is null on a non-root path", () => {
        expect(source).toMatch(/if\s*\(\s*pathname\s*===\s*"\/"\s*\|\|\s*account\s*\)/);
        expect(source).toMatch(/const\s+next\s*=\s*search\s*\?\s*`\$\{pathname\}\?\$\{search\}`\s*:\s*pathname;/);
        expect(source).toContain("href={buildLoginEntryHref(next)}");
        expect(source).toContain('className="wallet-connect-fallback"');
        expect(source).toContain('className="wallet-dot"');
        expect(source).toContain('aria-label={t("connect")}');
    });
});
