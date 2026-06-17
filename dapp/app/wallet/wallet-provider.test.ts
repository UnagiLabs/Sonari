import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourcePath = resolve(import.meta.dirname, "wallet-provider.tsx");

async function readSource() {
    return readFile(sourcePath, "utf8");
}

describe("WalletProvider", () => {
    it("renders RegisterEnokiWallets inside DAppKitProvider before children", async () => {
        const source = await readSource();

        expect(source).toContain('import { RegisterEnokiWallets } from "./enoki-wallets";');
        expect(source).toContain("<DAppKitProvider");
        expect(source).toContain("<RegisterEnokiWallets />");
        expect(source).toContain("{children}");

        const providerOpenIndex = source.indexOf("<DAppKitProvider");
        const registerIndex = source.indexOf("<RegisterEnokiWallets />");
        const childrenIndex = source.indexOf("{children}");
        const providerCloseIndex = source.indexOf("</DAppKitProvider>");

        expect(providerOpenIndex).toBeGreaterThanOrEqual(0);
        expect(registerIndex).toBeGreaterThan(providerOpenIndex);
        expect(childrenIndex).toBeGreaterThan(registerIndex);
        expect(providerCloseIndex).toBeGreaterThan(childrenIndex);
    });
});
