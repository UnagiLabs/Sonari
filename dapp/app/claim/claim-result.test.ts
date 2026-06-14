import { describe, expect, it } from "vitest";
import { buildClaimResultView, type TxState } from "./claim-result";

const digest = "8oM2nT3kQ4abcDEFghiJKLmnopQRstUVwxyz1234567";

describe("buildClaimResultView", () => {
    it("idle is not loading and shows no link or CTA", () => {
        const view = buildClaimResultView({ status: "idle" }, "testnet");
        expect(view).toEqual({
            loading: false,
            digest: null,
            explorerUrl: null,
            showDashboardCta: false,
        });
    });

    it("building is loading", () => {
        const view = buildClaimResultView({ status: "building" }, "testnet");
        expect(view.loading).toBe(true);
        expect(view.showDashboardCta).toBe(false);
    });

    it("submitting is loading", () => {
        const view = buildClaimResultView({ status: "submitting" }, "testnet");
        expect(view.loading).toBe(true);
        expect(view.showDashboardCta).toBe(false);
    });

    it("submitted on testnet exposes the digest, explorer URL, and CTA", () => {
        const state: TxState = { status: "submitted", digest };
        const view = buildClaimResultView(state, "testnet");
        expect(view).toEqual({
            loading: false,
            digest,
            explorerUrl: `https://suiscan.xyz/testnet/tx/${digest}`,
            showDashboardCta: true,
        });
    });

    it("submitted on localnet keeps the digest and CTA but has no explorer URL", () => {
        const state: TxState = { status: "submitted", digest };
        const view = buildClaimResultView(state, "localnet");
        expect(view.digest).toBe(digest);
        expect(view.explorerUrl).toBeNull();
        expect(view.showDashboardCta).toBe(true);
        expect(view.loading).toBe(false);
    });

    it("failed is not loading and shows no link or CTA", () => {
        const state: TxState = {
            status: "failed",
            message: { kind: "key", key: "tx.failed.generic" },
        };
        const view = buildClaimResultView(state, "testnet");
        expect(view.loading).toBe(false);
        expect(view.showDashboardCta).toBe(false);
        expect(view.explorerUrl).toBeNull();
    });
});
