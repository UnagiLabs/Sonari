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
    type WizardStepId,
} from "./wizard-steps";

// MEMBERSHIP_STATEMENT_COUNT / RESIDENCE_STATEMENT_COUNT は wizard-storage.test.ts が
// import しているため削除できない。STEP 2 で STORAGE_VERSION を上げるタイミングで整理する。
void MEMBERSHIP_STATEMENT_COUNT;
void RESIDENCE_STATEMENT_COUNT;

export const WIZARD_STORAGE_KEY = "sonari.register.wizard.v1";

export function clearWizardStorage(storage: Storage): void {
    storage.removeItem(WIZARD_STORAGE_KEY);
}

/** done ステップ到達時に登録が完了していれば storage をクリアすべきかを返す純粋関数。 */
export function shouldClearStorage(activeStep: WizardStepId, state: WizardState): boolean {
    return activeStep === "done" && state.membershipIssued && state.residenceSaved;
}

const STORAGE_VERSION = 1;

// H3 セルは res7 の 10 進文字列としてのみ受け付ける。
const DECIMAL_CELL_PATTERN = /^[0-9]{1,20}$/;

const IDENTITY_PROVIDERS: readonly WizardIdentityProvider[] = ["kyc", "world_id"];

export function serializeWizardState(state: WizardState): string {
    return JSON.stringify({
        version: STORAGE_VERSION,
        membershipIssued: state.membershipIssued,
        disclaimersAccepted: state.disclaimersAccepted,
        selectedCellDecimal: state.selectedCellDecimal,
        residenceSaved: state.residenceSaved,
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

    const membershipIssued = parsed.membershipIssued;
    const disclaimersAccepted = parsed.disclaimersAccepted;
    const selectedCellDecimal = readCellDecimal(parsed.selectedCellDecimal);
    // residenceSaved は欠落時のみ false にフォールバック（既存セッションのデータを失わない）。
    // フィールドが存在するが boolean 以外なら fail-closed で初期状態へ落とす。
    const residenceSaved = parsed.residenceSaved === undefined ? false : parsed.residenceSaved;
    const identityProvider = readIdentityProvider(parsed.identityProvider);
    const identityVerified = parsed.identityVerified;

    if (
        typeof membershipIssued !== "boolean" ||
        typeof disclaimersAccepted !== "boolean" ||
        selectedCellDecimal === undefined ||
        typeof residenceSaved !== "boolean" ||
        identityProvider === null ||
        typeof identityVerified !== "boolean"
    ) {
        return initial;
    }

    return {
        membershipIssued,
        disclaimersAccepted,
        selectedCellDecimal,
        residenceSaved,
        identityProvider,
        identityVerified,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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
