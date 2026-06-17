# Sonari dapp

Next.js (App Router) web app for Sonari — the donation, registration, and claim UI. Uses next-intl for i18n, Sui dApp Kit for wallet flows, and World ID IDKit for identity. Built with OpenNext and deployed to Cloudflare Workers at [sonari.help](https://sonari.help).

- **Role**: product web surface; never decides eligibility — all verification is downstream (TEE + Move)
- **Trust boundary**: untrusted client; forwards proofs, never reinterprets results

## Where to Read More
- [../README.md](../README.md) — project overview & documentation index

## Enoki / Google zkLogin Testnet Setup

This setup only fixes the public configuration contract for testnet. Wallet
registration and transaction execution stay on the existing Sui dApp Kit path.

1. Create a testnet app in Enoki Portal.
2. Create a Google OAuth Client ID in Google Cloud Console.
3. Configure the Google OAuth client with these values:

| Google OAuth field | Values |
|--------------------|--------|
| authorized JavaScript origins | `http://localhost:3000`, `https://sonari.help` |
| authorized redirect URIs | `http://localhost:3000/`, `https://sonari.help/` |

4. Register that Google OAuth Client ID in the Enoki Portal Google provider.
5. Add the allowed origins `http://localhost:3000` and `https://sonari.help` in Enoki Portal.
6. Store these public build-time values in the `cloudflare-dapp-worker`
   GitHub Environment Variables:

```env
NEXT_PUBLIC_ENOKI_API_KEY=
NEXT_PUBLIC_ENOKI_GOOGLE_CLIENT_ID=
```

Enoki uses the shared `NEXT_PUBLIC_SUI_NETWORK` value. It is enabled only when
that value is explicitly `testnet`.

`NEXT_PUBLIC_*` values are bundled into the browser. Do not put secrets,
private API keys, OAuth client secrets, signing keys, or mnemonics there.

`POST /api/enoki/membership/sponsor` and
`POST /api/enoki/membership/execute` use `ENOKI_PRIVATE_API_KEY` as a
server-only secret for MembershipPass issuance. Register it as a GitHub
Environment Secret in `cloudflare-dapp-worker`; the dapp deploy workflow syncs
it to the Cloudflare Worker runtime secret before deploy.

```bash
gh secret set ENOKI_PRIVATE_API_KEY -R UnagiLabs/Sonari -e cloudflare-dapp-worker --body "<ENOKI_PRIVATE_API_KEY>"
```

---

# Sonari dapp（日本語）

Sonari の Next.js（App Router）Web アプリ。寄付・登録・claim の UI を提供する。i18n は next-intl、ウォレット操作は Sui dApp Kit、本人確認は World ID IDKit を使用。OpenNext でビルドし Cloudflare Workers にデプロイ（[sonari.help](https://sonari.help)）。

- **役割**: プロダクトの Web 表側。受給資格は判断しない（検証は全て下流＝TEE + Move）
- **信頼境界**: 信頼しないクライアント。proof を転送するだけで結果を再解釈しない

## 詳細資料
- [../README.md](../README.md) — プロジェクト概要・ドキュメント索引

## Enoki / Google zkLogin testnet 設定

この設定は、testnet 用の公開 env 契約だけを固定します。wallet 登録や
transaction 実行は、既存の Sui dApp Kit 経路から変えません。

1. Enoki Portal で testnet app を作成する。
2. Google Cloud Console で Google OAuth Client ID を作成する。
3. Google OAuth client に次の値を設定する。

| Google OAuth field | Values |
|--------------------|--------|
| authorized JavaScript origins | `http://localhost:3000`, `https://sonari.help` |
| authorized redirect URIs | `http://localhost:3000/`, `https://sonari.help/` |

4. Enoki Portal の Google provider に同じ Google OAuth Client ID を登録する。
5. Enoki Portal の allowed origin に `http://localhost:3000` と `https://sonari.help` を追加する。
6. `cloudflare-dapp-worker` の GitHub Environment Variables に公開値を登録する。

```env
NEXT_PUBLIC_ENOKI_API_KEY=
NEXT_PUBLIC_ENOKI_GOOGLE_CLIENT_ID=
```

Enoki は dapp 共通の `NEXT_PUBLIC_SUI_NETWORK` を使います。
この値が明示的に `testnet` の時だけ有効になります。

`NEXT_PUBLIC_*` はブラウザの bundle に入ります。NEXT_PUBLIC_* に secret を置かないでください。
private API key、OAuth client secret、署名鍵、ニーモニックは入れません。

`ENOKI_PRIVATE_API_KEY` は `POST /api/enoki/membership/sponsor` と
`POST /api/enoki/membership/execute` が使う MembershipPass 発行専用の
server-only secret です。`cloudflare-dapp-worker` の GitHub Environment Secret
として登録します。dapp deploy workflow が deploy 前に Cloudflare Worker runtime
secret へ同期します。

```bash
gh secret set ENOKI_PRIVATE_API_KEY -R UnagiLabs/Sonari -e cloudflare-dapp-worker --body "<ENOKI_PRIVATE_API_KEY>"
```
