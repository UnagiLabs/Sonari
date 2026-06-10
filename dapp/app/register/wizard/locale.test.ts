import { describe, expect, it } from "vitest";
import { parseLocale, SONARI_LOCALE_COOKIE, SUPPORTED_LOCALES } from "./locale";

describe("parseLocale", () => {
    it("サポートする locale はそのまま返す", () => {
        expect(parseLocale("en")).toBe("en");
        expect(parseLocale("ja")).toBe("ja");
    });

    it("未知の値 / null / undefined は en に落ちる", () => {
        expect(parseLocale("fr")).toBe("en");
        expect(parseLocale("")).toBe("en");
        expect(parseLocale(null)).toBe("en");
        expect(parseLocale(undefined)).toBe("en");
    });
});

describe("locale 定数", () => {
    it("cookie 名とサポート locale が固定されている", () => {
        expect(SONARI_LOCALE_COOKIE).toBe("SONARI_LOCALE");
        expect(SUPPORTED_LOCALES).toEqual(["en", "ja"]);
    });
});
