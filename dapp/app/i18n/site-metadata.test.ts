import { describe, expect, it } from "vitest";
import { canonicalMetadata, rootMetadata, SITE_URL } from "./site-metadata";

// サイト共通メタデータの単体テスト。OGP・Twitter Card・canonical の必須項目が
// 揃い、絶対 URL の基準（metadataBase）が本番ドメインを指すことを固定する。

describe("SITE_URL", () => {
    it("本番ドメインを指す", () => {
        expect(SITE_URL).toBe("https://sonari.help");
    });
});

describe("rootMetadata", () => {
    it("metadataBase が SITE_URL を指す", () => {
        expect(rootMetadata.metadataBase?.href).toBe("https://sonari.help/");
    });

    it("OGP に種別・タイトル・画像がある", () => {
        const og = rootMetadata.openGraph;
        expect(og).toBeTruthy();
        expect(og?.title).toBeTruthy();
        // 暫定 OGP 画像（ロゴ）を含む
        expect(JSON.stringify(og)).toContain("/assets/sonari_logo.png");
    });

    it("Twitter Card が summary で画像を持つ", () => {
        const tw = rootMetadata.twitter;
        expect(tw).toBeTruthy();
        expect(JSON.stringify(tw)).toContain("summary");
        expect(JSON.stringify(tw)).toContain("/assets/sonari_logo.png");
    });
});

describe("canonicalMetadata", () => {
    it("渡したパスを canonical に設定する", () => {
        expect(canonicalMetadata("/donate").alternates?.canonical).toBe("/donate");
        expect(canonicalMetadata("/").alternates?.canonical).toBe("/");
    });
});
