# Contracts Development Flow

この文書は、target MVP 仕様に合わせた contract 実装順序を示す。
現在の Move source は一部旧設計を含む。
実装 PR では、この順序で差分を小さく分ける。

## 1. 守る境界

- Worker / watcher は候補検出と queue 管理を行う。
- Nautilus / verifier は外部 source の再取得と検証を行う。
- Relayer は finalized payload を配送するだけにする。
- Move contract は署名済み result と on-chain state だけを信頼する。

raw KYC data、World ID proof detail、document image、phone、
GPS history、detailed address は on-chain に出さない。

## 2. Target MVP sequence

### PR A. Membership SBT target fields

目的:

- SBT owner を受取先にする。
- 災害前作成と災害前居住セル登録を保存する。
- 本人確認済み状態を保存する。

実装:

- `account_created_at_ms` を追加する。
- `home_cell` を追加する。
- `home_cell_registered_at_ms` を追加する。
- `identity_verified` を追加する。
- `identity_provider_mask` を追加する。
- `terms_version` を追加する。
- `signed_statement_hash` を追加する。

完了条件:

- active SBT だけが Claim precheck を通る。
- SBT owner が支払い先として使われる。
- raw identity data を保存しない。

### PR B. IdentityRegistry

目的:

- KYC と World ID の provider 内 duplicate key を管理する。

実装:

- KYC duplicate key table を追加する。
- World ID duplicate key table を追加する。
- duplicate key 使用済みなら reject する。
- KYC と World ID をまたぐ完全判定は MVP 外にする。

完了条件:

- 同じ KYC key を 2 回使えない。
- 同じ World ID key を 2 回使えない。
- provider をまたぐ注意文への wallet 署名 hash を保存できる。

### PR C. Nautilus identity update

目的:

- KYC / World ID の署名済み result を SBT に反映する。

実装:

- provider を KYC / World ID に限定する。
- `verified == true` の result だけを反映する。
- issued / expiry を Clock で検証する。
- duplicate key を IdentityRegistry で検証する。
- replay を防ぐ。

完了条件:

- valid KYC result で SBT が verified になる。
- valid World ID result で SBT が verified になる。
- expired result は reject される。
- disabled verifier key は reject される。

### PR D. Disaster Claim eligibility

目的:

- 災害前条件、affected cell、本人確認を Claim に接続する。

実装:

- `disaster_cutoff_time` を判定に使う。
- `account_created_at_ms` が cutoff より前か検証する。
- `home_cell_registered_at_ms` が cutoff より前か検証する。
- affected cell proof と `home_cell` を照合する。
- `identity_verified == true` を要求する。
- SBT owner へ支払う。

完了条件:

- 未認証 SBT は Claim できない。
- 災害後作成 SBT は Claim できない。
- 災害後に居住セル登録した SBT は Claim できない。
- KYC verified SBT は満額 Claim できる。
- World ID verified SBT は満額 Claim できる。

### PR E. PayoutPolicy simplification

目的:

- 本人確認の段階評価に基づく係数を支払額から外す。

実装:

- Band 別 base amount を維持する。
- CampaignBudget と Pool 残高 cap を維持する。
- 本人確認 provider による支給率差を作らない。

完了条件:

- KYC verified と World ID verified は同じ band 金額になる。
- unverified は支払い不可になる。
- Operations Pool は支払い原資にならない。

## 3. Verification policy

Move source を変更した PR は、必ず次を実行する。

```bash
pnpm check:move
```

TypeScript shared contract を変更した PR は、必ず次を実行する。

```bash
pnpm check:ts
```

docs-only PR でも、仕様語の残存確認を行う。
旧条件が target MVP 条件として残っていないことを確認する。
