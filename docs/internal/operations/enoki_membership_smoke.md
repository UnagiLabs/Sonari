# Enoki membership smoke runbook

この runbook は、Google zkLogin で接続した wallet が gasless で
MembershipPass を発行できることを testnet で確認する手順です。

対象は dapp の手動 smoke と運用設定です。実装コードや secret 値は変更しません。

## Scope

- local dev の smoke 手順を固定します。
- Cloudflare preview の smoke 手順を固定します。
- deployed testnet の smoke 手順を固定します。
- Enoki Portal、Google OAuth、GitHub Environment、Cloudflare secret の確認項目をまとめます。
- `ENOKI_PRIVATE_API_KEY` の rotation 手順をまとめます。
- sponsor abuse を防ぐための確認項目をまとめます。

## Invariants

- Google zkLogin は testnet だけで有効にします。
- browser 側は `NEXT_PUBLIC_SUI_NETWORK=testnet` を使います。
- server route は `SONARI_SUI_NETWORK=testnet` を使います。
- `NEXT_PUBLIC_ENOKI_API_KEY` は browser に入る公開値です。
- `NEXT_PUBLIC_ENOKI_GOOGLE_CLIENT_ID` は browser に入る公開値です。
- `ENOKI_PRIVATE_API_KEY` は server-only secret です。
- `ENOKI_PRIVATE_API_KEY` を `NEXT_PUBLIC_*` に置いてはいけません。
- 本番の `ENOKI_PRIVATE_API_KEY` の正は GitHub Environment Secret です。
- deploy workflow が `ENOKI_PRIVATE_API_KEY` を Cloudflare Worker runtime secret へ同期します。
- `next dev` の local smoke では shell env を使います。
- OpenNext / Cloudflare preview では git 管理外の `dapp/.dev.vars` を使います。
- sponsor 対象は MembershipPass 発行フローだけです。

## Required settings

### Local files

`dapp/.env.local` に公開値を入れます。

```env
SONARI_SUI_NETWORK=testnet
NEXT_PUBLIC_SUI_NETWORK=testnet
NEXT_PUBLIC_ENOKI_API_KEY=<enoki-public-api-key>
NEXT_PUBLIC_ENOKI_GOOGLE_CLIENT_ID=<google-oauth-client-id>
```

`next dev` で local smoke する場合は、shell env に server-only secret を入れます。

```bash
export ENOKI_PRIVATE_API_KEY="<enoki-private-api-key>"
```

OpenNext / Cloudflare preview で local smoke する場合は、
`dapp/.dev.vars` に server-only secret を入れます。

```env
ENOKI_PRIVATE_API_KEY=<enoki-private-api-key>
```

`dapp/.env.local` と `dapp/.dev.vars` は git 管理外です。
shell env の key は smoke 後に `unset ENOKI_PRIVATE_API_KEY` で消します。

### GitHub Environment

`cloudflare-dapp-worker` の Environment Variables を確認します。

- `NEXT_PUBLIC_ENOKI_API_KEY`
- `NEXT_PUBLIC_ENOKI_GOOGLE_CLIENT_ID`
- `SONARI_SUI_NETWORK`
- 必要に応じて `SONARI_SUI_RPC_URL`

`cloudflare-dapp-worker` の Environment Secrets を確認します。

- `ENOKI_PRIVATE_API_KEY`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

`ENOKI_PRIVATE_API_KEY` は次の形で登録します。

```bash
gh secret set ENOKI_PRIVATE_API_KEY -R UnagiLabs/Sonari -e cloudflare-dapp-worker --body "<ENOKI_PRIVATE_API_KEY>"
```

### Cloudflare runtime

deployed Worker では `ENOKI_PRIVATE_API_KEY` が runtime secret として必要です。

通常は dapp deploy workflow が次を実行して同期します。

```bash
wrangler secret put ENOKI_PRIVATE_API_KEY --name sonari-dapp
```

手動で Cloudflare にだけ secret を入れても、運用上の正にはしません。
rotation は GitHub Environment Secret から始めます。

### Enoki Portal

- app は testnet 用に作ります。
- public API key は `NEXT_PUBLIC_ENOKI_API_KEY` に入れます。
- private API key は `ENOKI_PRIVATE_API_KEY` に入れます。
- Google provider に Google OAuth Client ID を登録します。
- allowed origin に `http://localhost:3000` を入れます。
- allowed origin に `https://sonari.help` を入れます。

preview URL で smoke する場合は、その origin も Enoki Portal に入れます。

### Google OAuth

Google Cloud Console の OAuth Client ID を確認します。

| field | value |
|---|---|
| authorized JavaScript origins | `http://localhost:3000`, `https://sonari.help` |
| authorized redirect URIs | `http://localhost:3000/`, `https://sonari.help/` |

preview URL で smoke する場合は、preview origin と root redirect URI も追加します。

query 付き URI は登録しません。

登録しない例:

```txt
https://sonari.help/?next=/register
https://sonari.help/register
```

dapp は Enoki の Google provider に origin root 固定の `redirectUrl` を渡します。

## Pre-smoke checks

コード変更後は先に自動検証を実行します。

```bash
pnpm --filter @sonari/dapp test
pnpm check:ts
```

設定値の混入先を確認します。

```bash
rg "NEXT_PUBLIC_ENOKI_API_KEY|NEXT_PUBLIC_ENOKI_GOOGLE_CLIENT_ID" dapp
rg "ENOKI_PRIVATE_API_KEY" dapp .github/workflows docs
```

`ENOKI_PRIVATE_API_KEY` が browser 向けの `NEXT_PUBLIC_*` として出ていないことを確認します。

## Local dev smoke

1. `dapp/.env.local` に `NEXT_PUBLIC_SUI_NETWORK=testnet` を入れます。
2. `dapp/.env.local` に `SONARI_SUI_NETWORK=testnet` を入れます。
3. `dapp/.env.local` に Enoki public key と Google OAuth Client ID を入れます。
4. shell env に `ENOKI_PRIVATE_API_KEY` を入れます。
5. `pnpm --filter @sonari/dapp dev` を起動します。
6. `http://localhost:3000/register` を開きます。
7. `ConnectButton` から Google zkLogin で接続します。
8. SUI balance が 0 の address を使います。
9. register wizard を進めます。
10. residence cell を選択します。
11. MembershipPass 発行ボタンを押します。
12. UI が `sponsor -> sign -> execute` の順に進むことを確認します。
13. MembershipPass lookup が issued になることを確認します。
14. `/mypage` で MembershipPass が読めることを確認します。
15. `/claim` 側で MembershipPass が読めることを確認します。
16. smoke 後に `unset ENOKI_PRIVATE_API_KEY` を実行します。

balance が 0 の address で成功することが重要です。
gas coin を使って成功した場合は、この smoke の合格にしません。

## Cloudflare preview smoke

Cloudflare runtime 相当で確認する場合は preview を使います。

1. local と同じ `.env.local` を用意します。
2. `dapp/.dev.vars` に `ENOKI_PRIVATE_API_KEY` を入れます。
3. `pnpm --filter @sonari/dapp run preview` を起動します。
4. preview の origin を Enoki Portal allowed origin に入れます。
5. preview の origin root を Google OAuth redirect URI に入れます。
6. preview の `/register` を開きます。
7. local dev smoke と同じ手順を実行します。

preview origin が `http://localhost:<port>` の場合も、redirect URI は root です。

```txt
http://localhost:<port>/
```

## Deployed testnet smoke

main deploy 後は `https://sonari.help` で確認します。

1. GitHub Actions の dapp deploy workflow が成功していることを確認します。
2. workflow の `Validate Cloudflare credentials` が成功していることを確認します。
3. workflow の `Sync Enoki private API key to Cloudflare secret` が成功していることを確認します。
4. deployed build が `NEXT_PUBLIC_SUI_NETWORK=testnet` であることを確認します。
5. deployed Worker runtime が `SONARI_SUI_NETWORK=testnet` であることを確認します。
6. `https://sonari.help/register` を開きます。
7. Google zkLogin で接続します。
8. SUI balance が 0 の address を使います。
9. register wizard を進めます。
10. residence cell を選択します。
11. MembershipPass 発行ボタンを押します。
12. UI が `sponsor -> sign -> execute` の順に進むことを確認します。
13. MembershipPass lookup が issued になることを確認します。
14. `/mypage` で MembershipPass が読めることを確認します。
15. `/claim` 側で MembershipPass が読めることを確認します。

## Expected failure

`ENOKI_PRIVATE_API_KEY` 未設定時の expected failure は条件付きです。

次の条件を満たす valid request で確認します。

- `SONARI_SUI_NETWORK=testnet`
- valid `NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID`
- sponsor route は valid `sender` を受け取る
- sponsor route は valid MembershipPass transaction kind を受け取る
- execute route は valid `digest` を受け取る
- execute route は valid base64 `signature` を受け取る
- `ENOKI_PRIVATE_API_KEY` だけが未設定

この条件では route は HTTP 500 を返します。

error code は次です。

```txt
missing_enoki_private_api_key
```

message は次です。

```txt
Enoki sponsorship is not configured.
```

invalid request や invalid package ID では、先に別の error が返ります。
その場合は `missing_enoki_private_api_key` の確認には使いません。

## Sponsor abuse checks

sponsor 対象は MembershipPass 発行フローだけです。

server route は transaction kind を読み、Move call target を allowlist で制限します。
allowlist は membership package の次の target だけです。

```txt
<package>::accessor::register_member
<package>::accessor::new_residence_proof_step_left
<package>::accessor::new_residence_proof_step_right
```

確認項目:

- donation、claim、任意 transfer は sponsor しません。
- `PaySui` など MembershipPass 発行に不要な command は拒否します。
- allowlist 外の Move call は拒否します。
- transaction kind bytes の size limit を維持します。
- `/api/enoki/membership/sponsor` は sender と transaction kind bytes だけを受け取ります。
- `/api/enoki/membership/execute` は digest と signature だけを受け取ります。

## Secret rotation

`ENOKI_PRIVATE_API_KEY` を rotate するときは、GitHub Environment Secret を先に更新します。

1. Enoki Portal で新しい private API key を発行します。
2. 古い key をすぐ消さず、短い overlap を確保します。
3. GitHub Environment Secret を更新します。

```bash
gh secret set ENOKI_PRIVATE_API_KEY -R UnagiLabs/Sonari -e cloudflare-dapp-worker --body "<NEW_ENOKI_PRIVATE_API_KEY>"
```

4. dapp deploy workflow を実行します。
5. `Sync Enoki private API key to Cloudflare secret` の成功を確認します。
6. deployed testnet smoke を実行します。
7. success を確認してから古い private API key を Enoki Portal で revoke します。
8. smoke をもう一度実行します。

`next dev` の local smoke で同じ key を使う場合は、shell env も更新します。

OpenNext / Cloudflare preview で同じ key を使う場合は、git 管理外の
`dapp/.dev.vars` も更新します。

## Troubleshooting

Google が wallet 選択肢に出ない場合:

- `NEXT_PUBLIC_SUI_NETWORK=testnet` を確認します。
- `NEXT_PUBLIC_ENOKI_API_KEY` を確認します。
- `NEXT_PUBLIC_ENOKI_GOOGLE_CLIENT_ID` を確認します。
- Enoki Portal の Google provider 設定を確認します。
- Enoki Portal の allowed origin を確認します。

Google OAuth popup が redirect URI error になる場合:

- Google OAuth の authorized redirect URI が origin root か確認します。
- local は `http://localhost:3000/` を使います。
- production は `https://sonari.help/` を使います。
- `/register` や query 付き URI を登録していないことを確認します。

sponsor が 500 になる場合:

- `SONARI_SUI_NETWORK=testnet` を確認します。
- `ENOKI_PRIVATE_API_KEY` の同期を確認します。
- `NEXT_PUBLIC_SONARI_MEMBERSHIP_PACKAGE_ID` を確認します。
- `Published.toml` 自動導出が効いているか確認します。

sponsor が 400 になる場合:

- sender が valid Sui address か確認します。
- transaction kind bytes が base64 か確認します。
- Move call target が allowlist 内か確認します。
- MembershipPass 発行以外を sponsor していないか確認します。
