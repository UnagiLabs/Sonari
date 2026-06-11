import { describe, expect, it } from "vitest";
import { ClaimProofError } from "./affected-cells-proof";
import { resolveClaimProofError, resolveClaimTxError } from "./claim-messages";

describe("resolveClaimProofError", () => {
    it("既知の ClaimProofError コードを翻訳キーへ写像する", () => {
        const cases: Array<[ClaimProofError["code"], string]> = [
            ["worker_url_missing", "errors.workerMissing"],
            ["outside_affected_area", "errors.outsideArea"],
            ["proof_fetch_failed", "errors.fetchFailed"],
            ["invalid_proof_response", "errors.verifyFailed"],
            ["proof_verification_failed", "errors.verifyFailed"],
        ];
        for (const [code, key] of cases) {
            expect(resolveClaimProofError(new ClaimProofError(code, "x"))).toEqual({
                kind: "key",
                key,
            });
        }
    });

    it("未知の Error は原文を raw として持つ", () => {
        expect(resolveClaimProofError(new Error("boom"))).toEqual({ kind: "raw", text: "boom" });
    });

    it("Error 以外は汎用キーへ落とす", () => {
        expect(resolveClaimProofError("nope")).toEqual({ kind: "key", key: "errors.generic" });
    });
});

describe("resolveClaimTxError", () => {
    it("Error は原文を raw として持つ", () => {
        expect(resolveClaimTxError(new Error("tx boom"))).toEqual({ kind: "raw", text: "tx boom" });
    });

    it("Error 以外は汎用キーへ落とす", () => {
        expect(resolveClaimTxError(null)).toEqual({ kind: "key", key: "tx.failed.generic" });
    });
});
