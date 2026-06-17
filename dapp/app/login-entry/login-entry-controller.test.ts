import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "login-entry-controller.tsx"), "utf8");
const pageSource = readFileSync(resolve(here, "../page.tsx"), "utf8");

describe("LoginEntryController", () => {
    it("is a client controller that reads router, search params, and account state", () => {
        expect(source.startsWith('"use client";')).toBe(true);
        expect(source).toContain('import { useCurrentAccount } from "@mysten/dapp-kit-react";');
        expect(source).toContain('import { useRouter, useSearchParams } from "next/navigation";');
        expect(source).toContain("const router = useRouter();");
        expect(source).toContain("const searchParams = useSearchParams();");
        expect(source).toContain("const account = useCurrentAccount();");
    });

    it("saves raw next through the existing helper and normalizes root to /", () => {
        expect(source).toContain(
            'import { consumeLoginNext, saveLoginNext } from "./login-next";',
        );
        expect(source).toMatch(/const\s+hasNextParam\s*=\s*searchParams\.has\("next"\);/);
        expect(source).toMatch(/const\s+rawNext\s*=\s*searchParams\.get\("next"\);/);
        expect(source).toContain("if (!hasNextParam)");
        expect(source).toContain("saveLoginNext(window.sessionStorage, rawNext);");
        expect(source).toContain('router.replace("/");');
    });

    it("consumes saved next after wallet connection and redirects once", () => {
        expect(source).toContain("const redirectedAfterConnectRef = useRef(false);");
        expect(source).toContain("const next = consumeLoginNext(window.sessionStorage);");
        expect(source).toContain("router.replace(next);");
    });

    it("is mounted from the root server page inside Suspense", () => {
        expect(pageSource).toContain('import { Suspense } from "react";');
        expect(pageSource).toContain(
            'import { LoginEntryController } from "./login-entry/login-entry-controller";',
        );
        expect(pageSource).toMatch(
            /<Suspense\s+fallback=\{null\}>\s*<LoginEntryController\s*\/>\s*<\/Suspense>/s,
        );
    });
});
