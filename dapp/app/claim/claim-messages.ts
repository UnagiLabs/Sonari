import { ClaimProofError } from "./affected-cells-proof";

// 表示メッセージの持ち方。翻訳カタログのキーを持つ場合（言語切替に追従する）と、
// JS の実行時エラー文字列をそのまま持つ場合（キー化できないので原文表示）の 2 種。
// いずれも claim 名前空間からの相対キーを使う。
export type ClaimMessage =
    | { readonly kind: "key"; readonly key: string }
    | { readonly kind: "raw"; readonly text: string };

// 受給資格チェックで投げられたエラーを表示メッセージへ写像する。
// 既知の ClaimProofError コードは翻訳キーへ、未知の Error は原文へ落とす。
export function resolveClaimProofError(error: unknown): ClaimMessage {
    if (error instanceof ClaimProofError) {
        switch (error.code) {
            case "worker_url_missing":
                return { kind: "key", key: "errors.workerMissing" };
            case "outside_affected_area":
                return { kind: "key", key: "errors.outsideArea" };
            case "proof_fetch_failed":
                return { kind: "key", key: "errors.fetchFailed" };
            case "invalid_proof_response":
            case "proof_verification_failed":
                return { kind: "key", key: "errors.verifyFailed" };
        }
    }
    return error instanceof Error
        ? { kind: "raw", text: error.message }
        : { kind: "key", key: "errors.generic" };
}

// 申請トランザクションの失敗を表示メッセージへ写像する。
// Error は原文、それ以外は汎用キーへ落とす。
export function resolveClaimTxError(error: unknown): ClaimMessage {
    return error instanceof Error
        ? { kind: "raw", text: error.message }
        : { kind: "key", key: "tx.failed.generic" };
}
