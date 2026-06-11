/**
 * membership ステップの primary ボタン可否・発行状態を導出する純粋関数モジュール。
 * React コンポーネントから切り離し、unit test で仕様を固定する。
 */

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

/**
 * オンチェーン照会結果の discriminated union。
 * membership-step.tsx の MembershipLookupViewState に対応。
 */
export type MembershipLookupViewState =
    | { readonly kind: "idle" }
    | { readonly kind: "loading" }
    | { readonly kind: "ok"; readonly membershipId: string }
    | { readonly kind: "none" }
    | { readonly kind: "multiple"; readonly count: number }
    | { readonly kind: "error"; readonly message: string };

/**
 * deriveMembershipActionState / deriveIssuanceStatus への入力型。
 */
export interface MembershipGateInput {
    /** 接続中ウォレットのアドレス（未接続時は空文字） */
    readonly owner: string;
    /** 居住セルの H3 セル ID（10進数文字列）。未選択は null */
    readonly selectedCellDecimal: string | null;
    /** 全同意チェックボックスが ON か */
    readonly allStatementsAccepted: boolean;
    /** 5 つの env 変数が全て非空か */
    readonly isConfigured: boolean;
    /** セッション内で発行成功フラグが立っているか（ウォレット切替時に false へリセットされる） */
    readonly membershipIssued: boolean;
    /** オンチェーン照会の現在状態 */
    readonly lookup: MembershipLookupViewState;
    /** トランザクション送信中か */
    readonly isSubmitting: boolean;
}

/**
 * Membership SBT の発行状態。
 *
 * - `issued`     — オンチェーンで確認済み、または発行直後フラグ立ち
 * - `checking`   — ウォレット接続済みで照会中または照会前
 * - `not_issued` — 未発行（ウォレット未接続または照会結果が none/multiple/error かつ未発行）
 */
export type MembershipIssuanceStatus = "issued" | "checking" | "not_issued";

/**
 * primary ボタンが disabled である理由コード。
 * 優先順位順: 未接続 → セル未選択 → 同意未完 → 送信中 → 照会中 → 複数保有 → 照会エラー → 未設定
 */
export type MembershipDisabledReason =
    | "wallet_disconnected"
    | "residence_unselected"
    | "statements_unaccepted"
    | "submitting"
    | "checking"
    | "multiple"
    | "lookup_error"
    | "not_configured";

/**
 * deriveMembershipActionState の戻り値。
 */
export type MembershipActionState =
    | { readonly disabled: false }
    | { readonly disabled: true; readonly reason: MembershipDisabledReason };

// ---------------------------------------------------------------------------
// ヘルパー: 理由コード → i18n キー
// ---------------------------------------------------------------------------

/**
 * MembershipDisabledReason を `register.wizard.membership` 名前空間内の
 * i18n キーに変換する純粋関数。
 * コンポーネントで `t(disabledReasonMessageKey(reason))` のように使う。
 */
export function disabledReasonMessageKey(reason: MembershipDisabledReason): string {
    switch (reason) {
        case "wallet_disconnected":
            return "issue.connectWallet";
        case "residence_unselected":
            return "issue.residenceRequired";
        case "statements_unaccepted":
            return "nextHint";
        case "submitting":
            return "issue.submitting";
        case "checking":
            return "issue.checking";
        case "multiple":
            return "issue.multiple";
        case "lookup_error":
            return "issue.lookupFailed";
        case "not_configured":
            return "issue.notConfigured";
    }
}

// ---------------------------------------------------------------------------
// 純粋関数
// ---------------------------------------------------------------------------

/**
 * Membership SBT の発行状態を導出する。
 *
 * - lookup.kind === "ok" → issued（オンチェーン照会結果を最優先）
 * - owner 接続済み かつ lookup が idle/loading → checking（照会中）
 * - owner 未接続 → not_issued（接続前は発行されていないとみなす）
 * - lookup が none/multiple/error の場合: membershipIssued===true なら issued を維持、
 *   そうでなければ not_issued
 */
export function deriveIssuanceStatus(input: MembershipGateInput): MembershipIssuanceStatus {
    // オンチェーン照会結果を最優先
    if (input.lookup.kind === "ok") {
        return "issued";
    }

    // ウォレット未接続: 照会不可なので not_issued
    if (input.owner.length === 0) {
        return "not_issued";
    }

    // ウォレット接続済みで照会中または照会前（ウォレット切替直後も含む）
    if (input.lookup.kind === "idle" || input.lookup.kind === "loading") {
        return "checking";
    }

    // lookup が none/multiple/error のケース:
    // 発行直後（membershipIssued=true）は issued を維持する
    if (input.membershipIssued) {
        return "issued";
    }

    return "not_issued";
}

/**
 * primary ボタンの有効/無効状態と disabled 理由を導出する純粋関数。
 *
 * 発行済み（issuanceStatus === "issued"）の場合はボタンは「次へ進む」用途で有効とする。
 * 未発行の場合は以下の優先順位で最初に該当した理由を返す:
 *  1. owner 未接続 → wallet_disconnected
 *  2. selectedCellDecimal === null → residence_unselected
 *  3. !allStatementsAccepted → statements_unaccepted
 *  4. isSubmitting → submitting
 *  5. lookup が idle/loading → checking
 *  6. lookup が multiple → multiple
 *  7. lookup が error → lookup_error
 *  8. !isConfigured → not_configured
 *  9. lookup が none 以外（フォールバック） → checking
 *
 * 全条件充足かつ lookup === "none" のときのみ disabled:false を返す。
 */
export function deriveMembershipActionState(input: MembershipGateInput): MembershipActionState {
    const issuanceStatus = deriveIssuanceStatus(input);

    // 発行済みなら「次へ進む」ボタンは常に有効
    if (issuanceStatus === "issued") {
        return { disabled: false };
    }

    // 優先順位 1: ウォレット未接続
    if (input.owner.length === 0) {
        return { disabled: true, reason: "wallet_disconnected" };
    }

    // 優先順位 2: 居住セル未選択
    if (input.selectedCellDecimal === null) {
        return { disabled: true, reason: "residence_unselected" };
    }

    // 優先順位 3: 同意未完
    if (!input.allStatementsAccepted) {
        return { disabled: true, reason: "statements_unaccepted" };
    }

    // 優先順位 4: 送信中
    if (input.isSubmitting) {
        return { disabled: true, reason: "submitting" };
    }

    // 優先順位 5: 照会中（idle/loading）
    if (input.lookup.kind === "idle" || input.lookup.kind === "loading") {
        return { disabled: true, reason: "checking" };
    }

    // 優先順位 6: 複数保有
    if (input.lookup.kind === "multiple") {
        return { disabled: true, reason: "multiple" };
    }

    // 優先順位 7: 照会エラー
    if (input.lookup.kind === "error") {
        return { disabled: true, reason: "lookup_error" };
    }

    // 優先順位 8: 未設定
    if (!input.isConfigured) {
        return { disabled: true, reason: "not_configured" };
    }

    // lookup === "none" かつ全条件充足 → 有効
    if (input.lookup.kind === "none") {
        return { disabled: false };
    }

    // フォールバック（安全側: 想定外の lookup.kind）
    return { disabled: true, reason: "checking" };
}
