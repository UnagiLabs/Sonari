export type WalletConnectionStatus =
    | "disconnected"
    | "connecting"
    | "reconnecting"
    | "connected";

export interface WalletStatusInput {
    readonly status: WalletConnectionStatus;
    readonly address?: string | null | undefined;
    readonly walletName?: string | null | undefined;
    readonly network?: string | null | undefined;
}

export interface WalletStatusView {
    readonly status: WalletConnectionStatus;
    readonly label: string;
    readonly shortAddress: string | null;
    readonly canAct: boolean;
}

const SHORT_ADDRESS_THRESHOLD = 11;
const SHORT_ADDRESS_PREFIX_LEN = 6;
const SHORT_ADDRESS_SUFFIX_LEN = 4;

export function formatAddress(address: string): string {
    const trimmed = address.trim();
    if (trimmed.length === 0) {
        return "";
    }
    if (trimmed.length <= SHORT_ADDRESS_THRESHOLD) {
        return trimmed;
    }
    const prefix = trimmed.slice(0, SHORT_ADDRESS_PREFIX_LEN);
    const suffix = trimmed.slice(-SHORT_ADDRESS_SUFFIX_LEN);
    return `${prefix}...${suffix}`;
}

function buildConnectedLabel(
    shortAddress: string | null,
    network: string | null | undefined,
    walletName: string | null | undefined,
): string {
    if (shortAddress === null) {
        return "Connected";
    }
    const parts: string[] = [shortAddress];
    if (network != null && network.length > 0) {
        parts.push(network);
    }
    if (walletName != null && walletName.length > 0) {
        parts.push(walletName);
    }
    return parts.join(" · ");
}

export function toWalletStatusView(input: WalletStatusInput): WalletStatusView {
    const { status, address, network, walletName } = input;

    const hasAddress = address != null && address.length > 0;
    const shortAddress = hasAddress ? formatAddress(address as string) : null;
    const canAct = status === "connected" && hasAddress;

    let label: string;
    switch (status) {
        case "disconnected":
            label = "Connect wallet";
            break;
        case "connecting":
            label = "Connecting…";
            break;
        case "reconnecting":
            label = "Reconnecting…";
            break;
        case "connected":
            label = buildConnectedLabel(shortAddress, network, walletName);
            break;
    }

    return {
        status,
        label,
        shortAddress,
        canAct,
    };
}

export function walletActionDisabledReason(input: WalletStatusInput): string | null {
    const { status, address } = input;
    const hasAddress = address != null && address.length > 0;

    if (status === "connected" && hasAddress) {
        return null;
    }

    switch (status) {
        case "disconnected":
            return "Connect your wallet to continue.";
        case "connecting":
            return "Connecting to wallet…";
        case "reconnecting":
            return "Reconnecting to wallet…";
        case "connected":
            return "Wallet address is unavailable.";
    }
}
