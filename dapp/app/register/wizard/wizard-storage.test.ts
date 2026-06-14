import { describe, expect, it } from "vitest";
import { createInitialWizardState, type WizardState } from "./wizard-steps";
import {
    clearWizardStorage,
    deserializeWizardState,
    serializeWizardState,
    shouldClearStorage,
    WIZARD_STORAGE_KEY,
} from "./wizard-storage";

const fullState: WizardState = {
    membershipIssued: true,
    disclaimersAccepted: true,
    selectedCellDecimal: "608533827635118079",
    residenceSaved: true,
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
        expect(WIZARD_STORAGE_KEY).toBe("sonari.register.wizard.v2");
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
                "disclaimersAccepted",
                "selectedCellDecimal",
                "residenceSaved",
                "identityProvider",
                "identityVerified",
            ].sort(),
        );
        expect(parsed.version).toBe(2);
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
            version: 99,
        });
        expect(deserializeWizardState(raw)).toEqual(initial);
    });

    it("旧 version（1）の JSON は初期状態を返す（fail-closed）", () => {
        const raw = JSON.stringify({
            ...JSON.parse(serializeWizardState(fullState)),
            version: 1,
        });
        expect(deserializeWizardState(raw)).toEqual(initial);
    });

    it("membershipIssued が boolean でなければ初期状態を返す", () => {
        const base = JSON.parse(serializeWizardState(fullState)) as Record<string, unknown>;
        expect(
            deserializeWizardState(JSON.stringify({ ...base, membershipIssued: "yes" })),
        ).toEqual(initial);
    });

    it("disclaimersAccepted が boolean でなければ初期状態を返す", () => {
        const base = JSON.parse(serializeWizardState(fullState)) as Record<string, unknown>;
        expect(
            deserializeWizardState(JSON.stringify({ ...base, disclaimersAccepted: "yes" })),
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

    it("residenceSaved が boolean でなければ初期状態を返す", () => {
        const base = JSON.parse(serializeWizardState(fullState)) as Record<string, unknown>;
        expect(
            deserializeWizardState(JSON.stringify({ ...base, residenceSaved: "yes" })),
        ).toEqual(initial);
    });
});

// ---------------------------------------------------------------------------
// residenceSaved の fail-soft（フィールド欠落は false として復元）
// ---------------------------------------------------------------------------

describe("residenceSaved の fail-soft", () => {
    it("residenceSaved フィールドが欠落していても他フィールドを保持して false で復元する", () => {
        const base = JSON.parse(serializeWizardState(fullState)) as Record<string, unknown>;
        const { residenceSaved: _removed, ...withoutResidenceSaved } = base;
        const restored = deserializeWizardState(JSON.stringify(withoutResidenceSaved));
        expect(restored.residenceSaved).toBe(false);
        expect(restored.membershipIssued).toBe(fullState.membershipIssued);
        expect(restored.selectedCellDecimal).toBe(fullState.selectedCellDecimal);
        expect(restored.identityVerified).toBe(fullState.identityVerified);
    });
});

// ---------------------------------------------------------------------------
// clearWizardStorage
// ---------------------------------------------------------------------------

describe("clearWizardStorage", () => {
    it("WIZARD_STORAGE_KEY を storage から削除する", () => {
        const storage = new Map<string, string>();
        storage.set(WIZARD_STORAGE_KEY, serializeWizardState(fullState));
        const fakeStorage = {
            removeItem: (key: string) => storage.delete(key),
        } as unknown as Storage;

        clearWizardStorage(fakeStorage);

        expect(storage.has(WIZARD_STORAGE_KEY)).toBe(false);
    });

    it("キーが存在しない場合でもエラーにならない", () => {
        const fakeStorage = {
            removeItem: (_key: string) => {},
        } as unknown as Storage;

        expect(() => clearWizardStorage(fakeStorage)).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// shouldClearStorage
// ---------------------------------------------------------------------------

const completedState: WizardState = {
    membershipIssued: true,
    disclaimersAccepted: true,
    selectedCellDecimal: "608533827635118079",
    residenceSaved: true,
    identityProvider: "world_id",
    identityVerified: false,
};

describe("shouldClearStorage", () => {
    it("done ステップかつ membershipIssued=true・residenceSaved=true なら true", () => {
        expect(shouldClearStorage("done", completedState)).toBe(true);
    });

    it("done ステップでも membershipIssued=false なら false", () => {
        expect(shouldClearStorage("done", { ...completedState, membershipIssued: false })).toBe(false);
    });

    it("done ステップでも residenceSaved=false なら false", () => {
        expect(shouldClearStorage("done", { ...completedState, residenceSaved: false })).toBe(false);
    });

    it("登録完了状態でも done 以外のステップなら false", () => {
        expect(shouldClearStorage("membership", completedState)).toBe(false);
        expect(shouldClearStorage("identity", completedState)).toBe(false);
        expect(shouldClearStorage("residence", completedState)).toBe(false);
        expect(shouldClearStorage("welcome", completedState)).toBe(false);
    });
});
