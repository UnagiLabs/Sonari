import type { MembershipLookupResult } from "../../identity/membership-lookup";

/**
 * ウォレット接続状態と MembershipLookupResult から導出する表示状態。
 * UI コンポーネントから切り離した純粋関数として定義し、unit test で仕様を固定する。
 */
export type MembershipPresenceView =
    | { readonly kind: "disconnected" }
    | { readonly kind: "checking" }
    | {
          readonly kind: "registered";
          /** 短縮済みオーナーアドレス（例: 0x12345678…abcd） */
          readonly ownerShort: string;
          /**
           * 確定した Membership SBT の object ID。
           * multiple の場合は確定できないため null。
           */
          readonly membershipId: string | null;
          /** multiple の場合のみ設定される保有数。ok の場合は undefined。 */
          readonly count?: number;
      }
    | { readonly kind: "not_registered" }
    | { readonly kind: "error"; readonly message: string }
    | { readonly kind: "unconfigured" };

export interface MembershipPresenceInput {
    /** ウォレットが接続済みか */
    readonly connected: boolean;
    /** 接続中ウォレットのアドレス（未接続時は空文字） */
    readonly owner: string;
    /**
     * オンチェーン照会結果。照会前または照会中は null。
     * null かつ connected=true のとき checking を返す。
     */
    readonly lookupResult: MembershipLookupResult | null;
    /**
     * 照会が実行可能か。package id 未設定環境では false を渡す。
     * false のとき connected でも checking にせず unconfigured を返す。
     * 省略時は true。
     */
    readonly lookupEnabled?: boolean;
}

/**
 * 長いアドレスを `0x1234567890…abcd` 形式に縮める。
 * 14 文字以下はそのまま返す。identity-step.tsx の private 関数 `shortId` と同一規則。
 */
export function shortAddress(value: string): string {
    if (value.length <= 14) {
        return value;
    }
    return `${value.slice(0, 10)}…${value.slice(-4)}`;
}

/**
 * ウォレット接続状態と MembershipLookupResult から表示状態を導出する純粋関数。
 *
 * - connected=false → disconnected
 * - connected=true かつ lookupResult=null → checking（照会中）
 * - lookupResult.kind=ok → registered（membershipId 確定）
 * - lookupResult.kind=multiple → registered（membershipId=null, count 付き）
 *   複数 SBT を保有している = 保有していることに変わりないので registered 扱い。
 *   UI 側で count を見て追加の警告を表示することを想定。
 * - lookupResult.kind=none → not_registered
 * - lookupResult.kind=error → error
 */
export function deriveMembershipPresenceView(
    input: MembershipPresenceInput,
): MembershipPresenceView {
    if (!input.connected) {
        return { kind: "disconnected" };
    }

    if (input.lookupEnabled === false) {
        return { kind: "unconfigured" };
    }

    if (input.lookupResult === null) {
        return { kind: "checking" };
    }

    switch (input.lookupResult.kind) {
        case "ok":
            return {
                kind: "registered",
                ownerShort: shortAddress(input.owner),
                membershipId: input.lookupResult.membershipId,
            };
        case "multiple":
            return {
                kind: "registered",
                ownerShort: shortAddress(input.owner),
                membershipId: null,
                count: input.lookupResult.count,
            };
        case "none":
            return { kind: "not_registered" };
        case "error":
            return { kind: "error", message: input.lookupResult.message };
    }
}
