import { describe, expect, it } from "vitest";
import {
    deriveIssuanceStatus,
    deriveMembershipActionState,
    type MembershipGateInput,
    type MembershipIssuanceStatus,
    type MembershipDisabledReason,
} from "./membership-gate";

// ---------------------------------------------------------------------------
// テスト用ヘルパー
// ---------------------------------------------------------------------------

const OWNER = `0x${"aa".repeat(32)}`; // 66-char Sui address

/** 全条件を満たした「発行可能」状態の基底入力 */
const baseEnabled: MembershipGateInput = {
    owner: OWNER,
    selectedCellDecimal: "123456789",
    allStatementsAccepted: true,
    isConfigured: true,
    membershipIssued: false,
    lookup: { kind: "none" },
    isSubmitting: false,
};

/** 発行済み状態の基底入力 */
const baseIssued: MembershipGateInput = {
    ...baseEnabled,
    lookup: { kind: "ok", membershipId: `0x${"cc".repeat(32)}` },
};

// ---------------------------------------------------------------------------
// deriveIssuanceStatus
// ---------------------------------------------------------------------------

describe("deriveIssuanceStatus", () => {
    it("returns issued when lookup is ok (オンチェーン照会を最優先)", () => {
        const result = deriveIssuanceStatus(baseIssued);
        expect(result).toBe<MembershipIssuanceStatus>("issued");
    });

    it("returns issued when lookup is ok even if membershipIssued is false", () => {
        const result = deriveIssuanceStatus({ ...baseIssued, membershipIssued: false });
        expect(result).toBe<MembershipIssuanceStatus>("issued");
    });

    it("returns checking when lookup is loading and owner is connected", () => {
        const result = deriveIssuanceStatus({
            ...baseEnabled,
            lookup: { kind: "loading" },
        });
        expect(result).toBe<MembershipIssuanceStatus>("checking");
    });

    it("returns checking when lookup is idle and owner is connected", () => {
        const result = deriveIssuanceStatus({
            ...baseEnabled,
            lookup: { kind: "idle" },
        });
        expect(result).toBe<MembershipIssuanceStatus>("checking");
    });

    it("returns not_issued when lookup is loading but owner is disconnected", () => {
        const result = deriveIssuanceStatus({
            ...baseEnabled,
            owner: "",
            lookup: { kind: "loading" },
        });
        expect(result).toBe<MembershipIssuanceStatus>("not_issued");
    });

    it("returns not_issued when lookup is idle and owner is disconnected", () => {
        const result = deriveIssuanceStatus({
            ...baseEnabled,
            owner: "",
            lookup: { kind: "idle" },
        });
        expect(result).toBe<MembershipIssuanceStatus>("not_issued");
    });

    it("returns not_issued when lookup is none and membershipIssued is false", () => {
        const result = deriveIssuanceStatus({ ...baseEnabled, lookup: { kind: "none" } });
        expect(result).toBe<MembershipIssuanceStatus>("not_issued");
    });

    it("returns issued when membershipIssued is true and lookup is none (発行直後)", () => {
        const result = deriveIssuanceStatus({
            ...baseEnabled,
            membershipIssued: true,
            lookup: { kind: "none" },
        });
        expect(result).toBe<MembershipIssuanceStatus>("issued");
    });

    it("returns issued when membershipIssued is true and lookup is multiple", () => {
        const result = deriveIssuanceStatus({
            ...baseEnabled,
            membershipIssued: true,
            lookup: { kind: "multiple", count: 2 },
        });
        expect(result).toBe<MembershipIssuanceStatus>("issued");
    });

    it("returns issued when membershipIssued is true and lookup is error", () => {
        const result = deriveIssuanceStatus({
            ...baseEnabled,
            membershipIssued: true,
            lookup: { kind: "error", message: "Network failure" },
        });
        expect(result).toBe<MembershipIssuanceStatus>("issued");
    });

    it("returns not_issued when lookup is multiple and membershipIssued is false", () => {
        const result = deriveIssuanceStatus({
            ...baseEnabled,
            membershipIssued: false,
            lookup: { kind: "multiple", count: 2 },
        });
        expect(result).toBe<MembershipIssuanceStatus>("not_issued");
    });

    it("returns not_issued when lookup is error and membershipIssued is false", () => {
        const result = deriveIssuanceStatus({
            ...baseEnabled,
            membershipIssued: false,
            lookup: { kind: "error", message: "Network failure" },
        });
        expect(result).toBe<MembershipIssuanceStatus>("not_issued");
    });

    // ウォレット切替シナリオ: A（発行済み）→ B（未発行）への切替直後
    // membershipIssued は false にリセットされ、lookup が loading になる
    it("returns checking when membershipIssued=false, lookup=loading, owner connected (ウォレット切替直後)", () => {
        const result = deriveIssuanceStatus({
            ...baseEnabled,
            membershipIssued: false,
            lookup: { kind: "loading" },
            owner: OWNER,
        });
        expect(result).toBe<MembershipIssuanceStatus>("checking");
    });
});

// ---------------------------------------------------------------------------
// deriveMembershipActionState
// ---------------------------------------------------------------------------

describe("deriveMembershipActionState", () => {
    // 発行済み → ボタン有効
    it("returns disabled:false when issued (lookup=ok)", () => {
        const result = deriveMembershipActionState(baseIssued);
        expect(result).toEqual({ disabled: false });
    });

    it("returns disabled:false when membershipIssued=true and lookup=none (発行直後)", () => {
        const result = deriveMembershipActionState({
            ...baseEnabled,
            membershipIssued: true,
        });
        expect(result).toEqual({ disabled: false });
    });

    // 全条件充足 + lookup=none → ボタン有効
    it("returns disabled:false when all conditions met and lookup=none", () => {
        const result = deriveMembershipActionState(baseEnabled);
        expect(result).toEqual({ disabled: false });
    });

    // 優先順位 1: owner 未接続
    it("returns wallet_disconnected when owner is empty (最優先)", () => {
        const result = deriveMembershipActionState({ ...baseEnabled, owner: "" });
        expect(result).toEqual<{ disabled: true; reason: MembershipDisabledReason }>({
            disabled: true,
            reason: "wallet_disconnected",
        });
    });

    it("wallet_disconnected beats residence_unselected", () => {
        const result = deriveMembershipActionState({
            ...baseEnabled,
            owner: "",
            selectedCellDecimal: null,
        });
        expect(result).toEqual({ disabled: true, reason: "wallet_disconnected" });
    });

    // 優先順位 2: セル未選択
    it("returns residence_unselected when selectedCellDecimal is null", () => {
        const result = deriveMembershipActionState({
            ...baseEnabled,
            selectedCellDecimal: null,
        });
        expect(result).toEqual({ disabled: true, reason: "residence_unselected" });
    });

    it("residence_unselected beats statements_unaccepted", () => {
        const result = deriveMembershipActionState({
            ...baseEnabled,
            selectedCellDecimal: null,
            allStatementsAccepted: false,
        });
        expect(result).toEqual({ disabled: true, reason: "residence_unselected" });
    });

    // 優先順位 3: 同意未完
    it("returns statements_unaccepted when allStatementsAccepted is false", () => {
        const result = deriveMembershipActionState({
            ...baseEnabled,
            allStatementsAccepted: false,
        });
        expect(result).toEqual({ disabled: true, reason: "statements_unaccepted" });
    });

    it("statements_unaccepted beats submitting", () => {
        const result = deriveMembershipActionState({
            ...baseEnabled,
            allStatementsAccepted: false,
            isSubmitting: true,
        });
        expect(result).toEqual({ disabled: true, reason: "statements_unaccepted" });
    });

    // 優先順位 4: 送信中
    it("returns submitting when isSubmitting is true", () => {
        const result = deriveMembershipActionState({
            ...baseEnabled,
            isSubmitting: true,
        });
        expect(result).toEqual({ disabled: true, reason: "submitting" });
    });

    it("submitting beats checking", () => {
        const result = deriveMembershipActionState({
            ...baseEnabled,
            isSubmitting: true,
            lookup: { kind: "loading" },
        });
        expect(result).toEqual({ disabled: true, reason: "submitting" });
    });

    // 優先順位 5: 照会中 (idle/loading)
    it("returns checking when lookup is loading", () => {
        const result = deriveMembershipActionState({
            ...baseEnabled,
            lookup: { kind: "loading" },
        });
        expect(result).toEqual({ disabled: true, reason: "checking" });
    });

    it("returns checking when lookup is idle", () => {
        const result = deriveMembershipActionState({
            ...baseEnabled,
            lookup: { kind: "idle" },
        });
        expect(result).toEqual({ disabled: true, reason: "checking" });
    });

    it("checking beats multiple", () => {
        // lookup=idle と multiple が同時というシナリオは現実には起きにくいが、
        // 優先順位の確認のために idle を先に評価することを検証する
        const result = deriveMembershipActionState({
            ...baseEnabled,
            lookup: { kind: "idle" },
        });
        expect(result).toEqual({ disabled: true, reason: "checking" });
    });

    // 優先順位 6: 複数保有
    it("returns multiple when lookup is multiple", () => {
        const result = deriveMembershipActionState({
            ...baseEnabled,
            lookup: { kind: "multiple", count: 2 },
        });
        expect(result).toEqual({ disabled: true, reason: "multiple" });
    });

    it("multiple beats lookup_error", () => {
        // multiple は error より優先される
        const result = deriveMembershipActionState({
            ...baseEnabled,
            lookup: { kind: "multiple", count: 3 },
        });
        expect(result).toEqual({ disabled: true, reason: "multiple" });
    });

    // 優先順位 7: 照会エラー
    it("returns lookup_error when lookup is error", () => {
        const result = deriveMembershipActionState({
            ...baseEnabled,
            lookup: { kind: "error", message: "Network failure" },
        });
        expect(result).toEqual({ disabled: true, reason: "lookup_error" });
    });

    it("lookup_error beats not_configured", () => {
        const result = deriveMembershipActionState({
            ...baseEnabled,
            isConfigured: false,
            lookup: { kind: "error", message: "err" },
        });
        expect(result).toEqual({ disabled: true, reason: "lookup_error" });
    });

    // 優先順位 8: 未設定
    it("returns not_configured when isConfigured is false and lookup is none", () => {
        const result = deriveMembershipActionState({
            ...baseEnabled,
            isConfigured: false,
            lookup: { kind: "none" },
        });
        expect(result).toEqual({ disabled: true, reason: "not_configured" });
    });

    // ウォレット切替直後: membershipIssued=false, lookup=loading → checking でブロック
    it("returns checking (not wallet_disconnected) during wallet switch with loading lookup", () => {
        const result = deriveMembershipActionState({
            ...baseEnabled,
            membershipIssued: false,
            lookup: { kind: "loading" },
            owner: OWNER,
        });
        expect(result).toEqual({ disabled: true, reason: "checking" });
    });

    // issued ならその他条件が未充足でも disabled:false (発行済は「次へ」用途)
    it("returns disabled:false even if allStatementsAccepted=false when issued", () => {
        const result = deriveMembershipActionState({
            ...baseIssued,
            allStatementsAccepted: false,
        });
        expect(result).toEqual({ disabled: false });
    });

    it("returns disabled:false even if selectedCellDecimal=null when issued", () => {
        const result = deriveMembershipActionState({
            ...baseIssued,
            selectedCellDecimal: null,
        });
        expect(result).toEqual({ disabled: false });
    });
});
