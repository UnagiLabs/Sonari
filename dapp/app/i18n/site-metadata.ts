import type { Metadata } from "next";

// サイト共通のメタデータを 1 箇所にまとめる。OGP（SNS 共有時の画像と説明）・
// Twitter Card・canonical（正規 URL）・favicon の設定を集約する。
// canonical はページごとに異なるため、各 page.tsx が canonicalMetadata で
// 自分のパスを設定する。共有部分（タイトル・OGP・Twitter）は rootMetadata が持つ。

/** サイトの本番ドメイン。OGP 画像や canonical の絶対 URL 解決に使う。 */
export const SITE_URL = "https://sonari.help";

const TITLE = "Sonari — Donations you can actually follow";
const DESCRIPTION =
    "Sonari helps donors send support directly to the right people, with transparent pools and proof they can follow.";

// OGP 専用画像はデザイン未確定のため、暫定でロゴを使う（差し替えは follow-up）。
const OG_IMAGE = "/assets/sonari_logo.png";

/**
 * ルートレイアウトが持つサイト共通メタデータ。
 * metadataBase を本番ドメインにすることで、OGP 画像や canonical の相対パスが
 * 絶対 URL に解決される。favicon は app/icon.png の file convention が担うため
 * ここでは設定しない。
 */
export const rootMetadata: Metadata = {
    metadataBase: new URL(SITE_URL),
    title: TITLE,
    description: DESCRIPTION,
    // og:url は固定値にするとページ別 canonical と食い違うため設定しない。
    // 正規 URL は各ページの canonical（alternates）が担う。
    openGraph: {
        type: "website",
        siteName: "Sonari",
        title: TITLE,
        description: DESCRIPTION,
        images: [{ url: OG_IMAGE, alt: "Sonari" }],
    },
    twitter: {
        card: "summary",
        title: TITLE,
        description: DESCRIPTION,
        images: [OG_IMAGE],
    },
};

/**
 * ページ固有の canonical（正規 URL のパス）を持つメタデータを作る。
 * 各 page.tsx が自分のルートパス（例: "/donate"）を渡す。相対パスは
 * metadataBase 起点で絶対 URL に解決される。
 */
export function canonicalMetadata(path: string): Metadata {
    return {
        alternates: {
            canonical: path,
        },
    };
}
