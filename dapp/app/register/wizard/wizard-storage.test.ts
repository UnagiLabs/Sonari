import { describe, expect, it } from "vitest";
import { createInitialWizardState, type WizardState } from "./wizard-steps";
import {
    deserializeWizardState,
    serializeWizardState,
    WIZARD_STORAGE_KEY,
} from "./wizard-storage";

const fullState: WizardState = {
    membershipIssued: true,
    membershipAccepted: [true, true, true],
    residenceAccepted: [true, false, true],
    selectedCellDecimal: "608533827635118079",
    identityProvider: "kyc",
    identityVerified: true,
};

// ---------------------------------------------------------------------------
// round-trip
// ---------------------------------------------------------------------------

describe("serializeWizardState / deserializeWizardState", () => {
    it("シリアライズ→デシリアライズで状態が完全に復元される", () => {
        const raw = serializeWizardState(fullState);
        expect(deserializeWizardState(raw)).toEqual(fullState);
    });

    it("初期状態も round-trip できる", () => {
        const initial = createInitialWizardState();
        expect(deserializeWizardState(serializeWizardState(initial))).toEqual(initial);
    });

    it("storage key はバージョン付きで固定", () => {
        expect(WIZARD_STORAGE_KEY).toBe("sonari.register.wizard.v1");
    });
});

// ---------------------------------------------------------------------------
// 保存対象の allowlist（プライバシー境界）
// ---------------------------------------------------------------------------

describe("保存対象の allowlist", () => {
    it("シリアライズ結果には version と allowlist のキーのみ含まれる", () => {
        const parsed = JSON.parse(serializeWizardState(fullState)) as Record<string, unknown>;
        expect(Object.keys(parsed).sort()).toEqual(
            [
                "version",
                "membershipIssued",
                "membershipAccepted",
                "residenceAccepted",
                "selectedCellDecimal",
                "identityProvider",
                "identityVerified",
            ].sort(),
        );
        expect(parsed.version).toBe(1);
    });

    it("wallet アドレスや World ID 応答に相当するキーは含まれない", () => {
        const raw = serializeWizardState(fullState);
        expect(raw).not.toMatch(/owner|address|wallet|idkit|nullifier|proof/i);
    });
});

// ---------------------------------------------------------------------------
// fail-closed（壊れた入力は初期状態へ）
// ---------------------------------------------------------------------------

describe("deserializeWizardState の fail-closed 検証", () => {
    const initial = createInitialWizardState();

    it("null / 空文字は初期状態を返す", () => {
        expect(deserializeWizardState(null)).toEqual(initial);
        expect(deserializeWizardState("")).toEqual(initial);
    });

    it("JSON として壊れた文字列は初期状態を返す", () => {
        expect(deserializeWizardState("{not json")).toEqual(initial);
    });

    it("オブジェクトでない JSON は初期状態を返す", () => {
        expect(deserializeWizardState('"text"')).toEqual(initial);
        expect(deserializeWizardState("[1,2,3]")).toEqual(initial);
    });

    it("未知の version は初期状態を返す", () => {
        const raw = JSON.stringify({
            ...JSON.parse(serializeWizardState(fullState)),
            version: 2,
        });
        expect(deserializeWizardState(raw)).toEqual(initial);
    });

    it("承諾フラグ配列の型や長さが不正なら初期状態を返す", () => {
        const base = JSON.parse(serializeWizardState(fullState)) as Record<string, unknown>;
        expect(
            deserializeWizardState(JSON.stringify({ ...base, membershipIssued: "yes" })),
        ).toEqual(initial);
        expect(
            deserializeWizardState(JSON.stringify({ ...base, membershipAccepted: [true, 1, true] })),
        ).toEqual(initial);
        expect(
            deserializeWizardState(JSON.stringify({ ...base, residenceAccepted: [true] })),
        ).toEqual(initial);
    });

    it("selectedCellDecimal が10進文字列でも null でもなければ初期状態を返す", () => {
        const base = JSON.parse(serializeWizardState(fullState)) as Record<string, unknown>;
        expect(
            deserializeWizardState(JSON.stringify({ ...base, selectedCellDecimal: "0x872f" })),
        ).toEqual(initial);
        expect(
            deserializeWizardState(JSON.stringify({ ...base, selectedCellDecimal: 12345 })),
        ).toEqual(initial);
    });

    it("identityProvider が未知の値なら初期状態を返す", () => {
        const base = JSON.parse(serializeWizardState(fullState)) as Record<string, unknown>;
        expect(
            deserializeWizardState(JSON.stringify({ ...base, identityProvider: "passport" })),
        ).toEqual(initial);
    });

    it("identityVerified が boolean でなければ初期状態を返す", () => {
        const base = JSON.parse(serializeWizardState(fullState)) as Record<string, unknown>;
        expect(
            deserializeWizardState(JSON.stringify({ ...base, identityVerified: "yes" })),
        ).toEqual(initial);
    });
});
