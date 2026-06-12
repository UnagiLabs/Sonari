import { describe, expect, it } from "vitest";
import {
    buildCampaignNotice,
    buildConfigNotice,
    buildPassNotice,
    buildWorldIdNotice,
} from "./claim-notices";

describe("claim notices", () => {
    it("surfaces missing or invalid claim config as non-retryable errors", () => {
        expect(buildConfigNotice("ok")).toBeNull();
        expect(buildConfigNotice("missing")).toEqual({
            key: "status.configMissing",
            level: "error",
            retryable: false,
        });
        expect(buildConfigNotice("invalid")).toEqual({
            key: "status.configInvalid",
            level: "error",
            retryable: false,
        });
    });

    it("marks campaign read failures and empty campaign lists as retryable", () => {
        expect(buildCampaignNotice({ status: "loading", campaignCount: 0 })).toEqual({
            key: "status.campaignsLoading",
            level: "info",
            retryable: false,
        });
        expect(buildCampaignNotice({ status: "failed", campaignCount: 0 })).toEqual({
            key: "status.campaignsFailed",
            level: "error",
            retryable: true,
        });
        expect(buildCampaignNotice({ status: "ready", campaignCount: 0 })).toEqual({
            key: "status.noCampaigns",
            level: "info",
            retryable: true,
        });
    });

    it("distinguishes wallet, missing pass, and failed pass states", () => {
        expect(buildPassNotice({ walletConnected: false, status: "idle" })).toEqual({
            key: "status.connectWallet",
            level: "info",
            retryable: false,
        });
        expect(buildPassNotice({ walletConnected: true, status: "none" })).toEqual({
            key: "status.passMissing",
            level: "error",
            retryable: true,
        });
        expect(buildPassNotice({ walletConnected: true, status: "failed" })).toEqual({
            key: "status.passFailed",
            level: "error",
            retryable: true,
        });
    });

    it("fails closed until World ID material is available", () => {
        expect(buildWorldIdNotice(null)).toBeNull();
        expect(buildWorldIdNotice("world_id_config")).toEqual({
            key: "status.worldIdConfigMissing",
            level: "error",
            retryable: false,
        });
        expect(buildWorldIdNotice("world_id_nullifier")).toEqual({
            key: "status.worldIdRequired",
            level: "info",
            retryable: false,
        });
    });
});
