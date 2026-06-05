/**
 * auth.test.ts
 *
 * token 認証関数のテスト。
 * fail-closed: secret 未設定・空・header 欠落・空 token・不一致はすべて 401。
 * 定数時間比較（timing-safe）を使うことで token の内容をタイミング攻撃で漏らさない。
 */
import { describe, expect, it } from "vitest";
import { AffectedCellsProofError } from "./errors.js";
import { type AuthEnv, verifyRegisterToken } from "./auth.js";

const VALID_SECRET = "super-secret-token-abc123";
const HEADER_NAME = "x-sonari-affected-proof-register-token";

function makeRequest(headerValue: string | null): Request {
    const headers = new Headers();
    if (headerValue !== null) {
        headers.set(HEADER_NAME, headerValue);
    }
    return new Request("https://example.com/", { method: "POST", headers });
}

function makeEnv(secret?: string): AuthEnv {
    if (secret === undefined) {
        // exactOptionalPropertyTypes: true なのでプロパティを省略する
        return {};
    }
    return { AFFECTED_PROOF_REGISTER_TOKEN: secret };
}

describe("verifyRegisterToken", () => {
    describe("正常系: token が一致する場合は throw しない", () => {
        it("正しい token を渡すと resolve する", async () => {
            const env = makeEnv(VALID_SECRET);
            const req = makeRequest(VALID_SECRET);
            await expect(verifyRegisterToken(req, env)).resolves.toBeUndefined();
        });

        it("スペースを含む token でも完全一致なら通る", async () => {
            const tokenWithSpace = "token with spaces 12345";
            const env = makeEnv(tokenWithSpace);
            const req = makeRequest(tokenWithSpace);
            await expect(verifyRegisterToken(req, env)).resolves.toBeUndefined();
        });
    });

    describe("fail-closed: secret 未設定 → 401", () => {
        it("AFFECTED_PROOF_REGISTER_TOKEN が undefined のとき 401 を throw する", async () => {
            const env = makeEnv(undefined);
            const req = makeRequest(VALID_SECRET);
            await expect(verifyRegisterToken(req, env)).rejects.toSatisfy(
                (e: unknown) =>
                    e instanceof AffectedCellsProofError &&
                    e.code === "unauthorized" &&
                    e.status === 401,
            );
        });

        it("AFFECTED_PROOF_REGISTER_TOKEN が空文字のとき 401 を throw する（fail-closed）", async () => {
            // secret 未設定と同等に扱う: 空 secret で「全員通す」の抜け穴を防ぐ
            const env = makeEnv("");
            const req = makeRequest(VALID_SECRET);
            await expect(verifyRegisterToken(req, env)).rejects.toSatisfy(
                (e: unknown) =>
                    e instanceof AffectedCellsProofError &&
                    e.code === "unauthorized" &&
                    e.status === 401,
            );
        });
    });

    describe("fail-closed: header 欠落 → 401", () => {
        it("x-sonari-affected-proof-register-token header がない場合 401 を throw する", async () => {
            const env = makeEnv(VALID_SECRET);
            const req = makeRequest(null);
            await expect(verifyRegisterToken(req, env)).rejects.toSatisfy(
                (e: unknown) =>
                    e instanceof AffectedCellsProofError &&
                    e.code === "unauthorized" &&
                    e.status === 401,
            );
        });
    });

    describe("fail-closed: 空 token → 401", () => {
        it("header が空文字のとき 401 を throw する", async () => {
            const env = makeEnv(VALID_SECRET);
            const req = makeRequest("");
            await expect(verifyRegisterToken(req, env)).rejects.toSatisfy(
                (e: unknown) =>
                    e instanceof AffectedCellsProofError &&
                    e.code === "unauthorized" &&
                    e.status === 401,
            );
        });
    });

    describe("fail-closed: token 不一致 → 401", () => {
        it("1 文字違いでも 401 を throw する", async () => {
            const env = makeEnv(VALID_SECRET);
            const req = makeRequest(VALID_SECRET.slice(0, -1) + "X");
            await expect(verifyRegisterToken(req, env)).rejects.toSatisfy(
                (e: unknown) =>
                    e instanceof AffectedCellsProofError &&
                    e.code === "unauthorized" &&
                    e.status === 401,
            );
        });

        it("完全に異なる token は 401 を throw する", async () => {
            const env = makeEnv(VALID_SECRET);
            const req = makeRequest("wrong-token");
            await expect(verifyRegisterToken(req, env)).rejects.toSatisfy(
                (e: unknown) =>
                    e instanceof AffectedCellsProofError &&
                    e.code === "unauthorized" &&
                    e.status === 401,
            );
        });

        it("長い token（secret が prefix）は 401 を throw する", async () => {
            // 長さ不一致で早期 return しない実装でも定数時間比較で弾く
            const env = makeEnv(VALID_SECRET);
            const req = makeRequest(VALID_SECRET + "-extra");
            await expect(verifyRegisterToken(req, env)).rejects.toSatisfy(
                (e: unknown) =>
                    e instanceof AffectedCellsProofError &&
                    e.code === "unauthorized" &&
                    e.status === 401,
            );
        });

        it("短い token（secret が suffix）は 401 を throw する", async () => {
            const env = makeEnv(VALID_SECRET);
            const req = makeRequest(VALID_SECRET.slice(5));
            await expect(verifyRegisterToken(req, env)).rejects.toSatisfy(
                (e: unknown) =>
                    e instanceof AffectedCellsProofError &&
                    e.code === "unauthorized" &&
                    e.status === 401,
            );
        });
    });

    describe("fail-closed: secret・token 両方空 → 401（fail-closed 優先）", () => {
        it("secret も token も空文字のとき 401 を throw する（secret 未設定は fail-closed）", async () => {
            const env = makeEnv("");
            const req = makeRequest("");
            await expect(verifyRegisterToken(req, env)).rejects.toSatisfy(
                (e: unknown) =>
                    e instanceof AffectedCellsProofError &&
                    e.code === "unauthorized" &&
                    e.status === 401,
            );
        });
    });
});
