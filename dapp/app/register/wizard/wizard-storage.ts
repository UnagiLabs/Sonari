// ウィザード状態の sessionStorage 永続化。
// 保存するのは allowlist のフィールドのみ。wallet アドレスや World ID 応答などの
// 個人・認証データは絶対に保存しない（プライバシー境界）。
// 読み出しは fail-closed: 形式が少しでも不正なら初期状態に落とす。

import {
    createInitialWizardState,
    MEMBERSHIP_STATEMENT_COUNT,
    RESIDENCE_STATEMENT_COUNT,
    type WizardIdentityProvider,
    type WizardState,
} from "./wizard-steps";

export const WIZARD_STORAGE_KEY = "sonari.register.wizard.v1";

const STORAGE_VERSION = 1;

// H3 セルは res7 の 10 進文字列としてのみ受け付ける。
const DECIMAL_CELL_PATTERN = /^[0-9]{1,20}$/;

const IDENTITY_PROVIDERS: readonly WizardIdentityProvider[] = ["kyc", "world_id"];

export function serializeWizardState(state: WizardState): string {
    return JSON.stringify({
        version: STORAGE_VERSION,
        membershipAccepted: state.membershipAccepted,
        residenceAccepted: state.residenceAccepted,
        selectedCellDecimal: state.selectedCellDecimal,
        identityProvider: state.identityProvider,
        identityVerified: state.identityVerified,
    });
}

export function deserializeWizardState(raw: string | null | undefined): WizardState {
    const initial = createInitialWizardState();
    if (typeof raw !== "string" || raw.length === 0) {
        return initial;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return initial;
    }
    if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION) {
        return initial;
    }

    const membershipAccepted = readBooleanArray(
        parsed.membershipAccepted,
        MEMBERSHIP_STATEMENT_COUNT,
    );
    const residenceAccepted = readBooleanArray(parsed.residenceAccepted, RESIDENCE_STATEMENT_COUNT);
    const selectedCellDecimal = readCellDecimal(parsed.selectedCellDecimal);
    const identityProvider = readIdentityProvider(parsed.identityProvider);
    const identityVerified = parsed.identityVerified;

    if (
        membershipAccepted === null ||
        residenceAccepted === null ||
        selectedCellDecimal === undefined ||
        identityProvider === null ||
        typeof identityVerified !== "boolean"
    ) {
        return initial;
    }

    return {
        membershipAccepted,
        residenceAccepted,
        selectedCellDecimal,
        identityProvider,
        identityVerified,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBooleanArray(value: unknown, expectedLength: number): readonly boolean[] | null {
    if (
        !Array.isArray(value) ||
        value.length !== expectedLength ||
        !value.every((entry) => typeof entry === "boolean")
    ) {
        return null;
    }
    return value;
}

/** 不正値は undefined（呼び出し側で fail-closed）。null は「未選択」として有効。 */
function readCellDecimal(value: unknown): string | null | undefined {
    if (value === null) {
        return null;
    }
    if (typeof value === "string" && DECIMAL_CELL_PATTERN.test(value)) {
        return value;
    }
    return undefined;
}

function readIdentityProvider(value: unknown): WizardIdentityProvider | null {
    return IDENTITY_PROVIDERS.includes(value as WizardIdentityProvider)
        ? (value as WizardIdentityProvider)
        : null;
}
