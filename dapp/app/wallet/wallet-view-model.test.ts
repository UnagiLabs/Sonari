import { describe, expect, it } from "vitest";
import {
    formatAddress,
    toWalletStatusView,
    walletActionDisabledReason,
} from "./wallet-view-model";

describe("formatAddress", () => {
    it("通常の長い hex を先頭6文字 + ... + 末尾4文字に短縮する", () => {
        const addr = "0x1234abcd5678ef901234abcd5678ef901234abcd5678ef901234abcd5678cdef";
        expect(formatAddress(addr)).toBe("0x1234...cdef");
    });

    it("空文字は空文字を返す", () => {
        expect(formatAddress("")).toBe("");
    });

    it("長さ 11 以下の短い文字列はそのまま返す", () => {
        expect(formatAddress("0x1234")).toBe("0x1234");
        expect(formatAddress("0x12345abcd")).toBe("0x12345abcd");
        // 11 文字（0x + 9桁）はそのまま
        expect(formatAddress("0x123456789")).toBe("0x123456789");
    });

    it("長さ 12 の文字列は短縮する", () => {
        expect(formatAddress("0x1234abcdef")).toBe("0x1234...cdef");
    });

    it("前後の空白を trim してから処理する", () => {
        const addr = "  0x1234abcd5678ef901234abcd5678ef901234abcd5678ef901234abcd5678cdef  ";
        expect(formatAddress(addr)).toBe("0x1234...cdef");
    });

    it("trim 後に 11 以下になる場合はそのまま返す", () => {
        expect(formatAddress("  0x1234  ")).toBe("0x1234");
    });
});

describe("toWalletStatusView", () => {
    describe("status=disconnected", () => {
        it("label が 'Connect wallet' になる", () => {
            const view = toWalletStatusView({ status: "disconnected" });
            expect(view.label).toBe("Connect wallet");
        });

        it("canAct が false になる", () => {
            const view = toWalletStatusView({ status: "disconnected" });
            expect(view.canAct).toBe(false);
        });

        it("shortAddress が null になる", () => {
            const view = toWalletStatusView({ status: "disconnected" });
            expect(view.shortAddress).toBeNull();
        });

        it("status をそのまま通す", () => {
            const view = toWalletStatusView({ status: "disconnected" });
            expect(view.status).toBe("disconnected");
        });
    });

    describe("status=connecting", () => {
        it("label が 'Connecting…' になる（U+2026）", () => {
            const view = toWalletStatusView({ status: "connecting" });
            expect(view.label).toBe("Connecting…");
        });

        it("canAct が false になる", () => {
            const view = toWalletStatusView({ status: "connecting" });
            expect(view.canAct).toBe(false);
        });

        it("address があっても canAct は false", () => {
            const view = toWalletStatusView({
                status: "connecting",
                address: "0x1234abcd5678ef901234abcd5678ef901234abcd5678ef901234abcd5678cdef",
            });
            expect(view.canAct).toBe(false);
        });

        it("shortAddress が null になる（address なし）", () => {
            const view = toWalletStatusView({ status: "connecting" });
            expect(view.shortAddress).toBeNull();
        });
    });

    describe("status=reconnecting", () => {
        it("label が 'Reconnecting…' になる（U+2026）", () => {
            const view = toWalletStatusView({ status: "reconnecting" });
            expect(view.label).toBe("Reconnecting…");
        });

        it("canAct が false になる", () => {
            const view = toWalletStatusView({ status: "reconnecting" });
            expect(view.canAct).toBe(false);
        });
    });

    describe("status=connected", () => {
        const fullAddr = "0x1234abcd5678ef901234abcd5678ef901234abcd5678ef901234abcd5678cdef";

        it("address・network・walletName が揃う場合の label", () => {
            const view = toWalletStatusView({
                status: "connected",
                address: fullAddr,
                network: "testnet",
                walletName: "Slush",
            });
            expect(view.label).toBe("0x1234...cdef · testnet · Slush");
        });

        it("network が無い場合は省く", () => {
            const view = toWalletStatusView({
                status: "connected",
                address: fullAddr,
                walletName: "Slush",
            });
            expect(view.label).toBe("0x1234...cdef · Slush");
        });

        it("walletName が無い場合は省く", () => {
            const view = toWalletStatusView({
                status: "connected",
                address: fullAddr,
                network: "testnet",
            });
            expect(view.label).toBe("0x1234...cdef · testnet");
        });

        it("address だけの場合は shortAddress のみ", () => {
            const view = toWalletStatusView({
                status: "connected",
                address: fullAddr,
            });
            expect(view.label).toBe("0x1234...cdef");
        });

        it("address が無い connected は 'Connected' にフォールバック", () => {
            const view = toWalletStatusView({
                status: "connected",
                network: "testnet",
            });
            expect(view.label).toBe("Connected");
        });

        it("canAct が true になる（address あり）", () => {
            const view = toWalletStatusView({
                status: "connected",
                address: fullAddr,
            });
            expect(view.canAct).toBe(true);
        });

        it("canAct が false になる（address 欠落）", () => {
            const view = toWalletStatusView({ status: "connected" });
            expect(view.canAct).toBe(false);
        });

        it("canAct が false になる（address が null）", () => {
            const view = toWalletStatusView({ status: "connected", address: null });
            expect(view.canAct).toBe(false);
        });

        it("shortAddress が formatAddress された値になる", () => {
            const view = toWalletStatusView({
                status: "connected",
                address: fullAddr,
            });
            expect(view.shortAddress).toBe("0x1234...cdef");
        });

        it("address が無いとき shortAddress は null", () => {
            const view = toWalletStatusView({ status: "connected" });
            expect(view.shortAddress).toBeNull();
        });
    });
});

describe("walletActionDisabledReason", () => {
    const fullAddr = "0x1234abcd5678ef901234abcd5678ef901234abcd5678ef901234abcd5678cdef";

    it("connected かつ address あり → null", () => {
        expect(
            walletActionDisabledReason({ status: "connected", address: fullAddr }),
        ).toBeNull();
    });

    it("disconnected → 接続誘導メッセージ", () => {
        expect(walletActionDisabledReason({ status: "disconnected" })).toBe(
            "Connect your wallet to continue.",
        );
    });

    it("connecting → 接続中メッセージ（U+2026）", () => {
        expect(walletActionDisabledReason({ status: "connecting" })).toBe(
            "Connecting to wallet…",
        );
    });

    it("reconnecting → 再接続中メッセージ（U+2026）", () => {
        expect(walletActionDisabledReason({ status: "reconnecting" })).toBe(
            "Reconnecting to wallet…",
        );
    });

    it("connected だが address 欠落 → unavailable メッセージ", () => {
        expect(walletActionDisabledReason({ status: "connected" })).toBe(
            "Wallet address is unavailable.",
        );
    });

    it("connected だが address が null → unavailable メッセージ", () => {
        expect(walletActionDisabledReason({ status: "connected", address: null })).toBe(
            "Wallet address is unavailable.",
        );
    });
});
