export type ClaimNoticeLevel = "info" | "error";

export interface ClaimNotice {
    readonly key: string;
    readonly level: ClaimNoticeLevel;
    readonly retryable: boolean;
}

export type PassNoticeStatus = "idle" | "loading" | "ready" | "none" | "failed";
export type CampaignNoticeStatus = "loading" | "ready" | "failed";
export type ConfigNoticeStatus = "ok" | "missing" | "invalid";
export type WorldIdNoticeReason = "world_id_config" | "world_id_nullifier" | null;

export function buildConfigNotice(status: ConfigNoticeStatus): ClaimNotice | null {
    switch (status) {
        case "ok":
            return null;
        case "missing":
            return { key: "status.configMissing", level: "error", retryable: false };
        case "invalid":
            return { key: "status.configInvalid", level: "error", retryable: false };
    }
}

export function buildCampaignNotice(input: {
    readonly status: CampaignNoticeStatus;
    readonly campaignCount: number;
}): ClaimNotice | null {
    switch (input.status) {
        case "loading":
            return { key: "status.campaignsLoading", level: "info", retryable: false };
        case "failed":
            return { key: "status.campaignsFailed", level: "error", retryable: true };
        case "ready":
            return input.campaignCount === 0
                ? { key: "status.noCampaigns", level: "info", retryable: true }
                : null;
    }
}

export function buildPassNotice(input: {
    readonly walletConnected: boolean;
    readonly status: PassNoticeStatus;
}): ClaimNotice | null {
    if (!input.walletConnected) {
        return { key: "status.connectWallet", level: "info", retryable: false };
    }

    switch (input.status) {
        case "idle":
        case "loading":
            return { key: "status.passLoading", level: "info", retryable: false };
        case "ready":
            return null;
        case "none":
            return { key: "status.passMissing", level: "error", retryable: true };
        case "failed":
            return { key: "status.passFailed", level: "error", retryable: true };
    }
}

export function buildWorldIdNotice(reason: WorldIdNoticeReason): ClaimNotice | null {
    switch (reason) {
        case null:
            return null;
        case "world_id_config":
            return { key: "status.worldIdConfigMissing", level: "error", retryable: false };
        case "world_id_nullifier":
            return { key: "status.worldIdRequired", level: "info", retryable: false };
    }
}
