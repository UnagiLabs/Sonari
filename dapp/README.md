# Sonari dapp

Next.js (App Router) web app for Sonari — the donation, registration, and claim UI. Uses next-intl for i18n, Sui dApp Kit for wallet flows, and World ID IDKit for identity. Built with OpenNext and deployed to Cloudflare Workers at [sonari.help](https://sonari.help).

- **Role**: product web surface; never decides eligibility — all verification is downstream (TEE + Move)
- **Trust boundary**: untrusted client; forwards proofs, never reinterprets results

## Where to Read More
- [../docs/webapp.md](../docs/webapp.md) — UI design and flows
- [../README.md](../README.md) — project overview & documentation index

---

# Sonari dapp（日本語）

Sonari の Next.js（App Router）Web アプリ。寄付・登録・claim の UI を提供する。i18n は next-intl、ウォレット操作は Sui dApp Kit、本人確認は World ID IDKit を使用。OpenNext でビルドし Cloudflare Workers にデプロイ（[sonari.help](https://sonari.help)）。

- **役割**: プロダクトの Web 表側。受給資格は判断しない（検証は全て下流＝TEE + Move）
- **信頼境界**: 信頼しないクライアント。proof を転送するだけで結果を再解釈しない

## 詳細資料
- [../docs/webapp.md](../docs/webapp.md) — UI 設計とフロー
- [../README.md](../README.md) — プロジェクト概要・ドキュメント索引
