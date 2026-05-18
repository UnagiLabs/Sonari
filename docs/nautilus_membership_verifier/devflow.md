# Sonari Nautilus Membership Verifier 開発フロー

この文書は `nautilus/verifiers/membership/` 配下の開発順序を定義する。初期段階では docs-only design、shared type placeholder、fixture placeholder、dummy verifier を優先し、本番 Nautilus / TEE 実装は後続 PR に分ける。

## 開発方針

- Membership verifier は Disaster verifier とは分ける。
- residence / student verifier は Membership Pass metadata update を生成する。
- raw email、phone、GPS 履歴、端末情報、住所、学籍番号などはオンチェーンに出さない。
- contracts は Nautilus 署名済み metadata update のみ支払い判定に使う。
- MVP は dummy implementation と fixtures で shape を固定する。
- runner / relayer / shared common utilities は、複数 verifier の実装重複が見えた時点で `nautilus/` 配下へ切り出す。

## PR 分割

### 1. docs-only design

対象:

- `docs/nautilus_membership_verifier/spec.md`
- `docs/nautilus_membership_verifier/devflow.md`
- `docs/business_logic.md`
- `docs/tech_stack.md`
- `contracts/spec.md`

やること:

- Membership verifier の責務を定義する。
- Residence verifier と Student verifier の output を定義する。
- Web MVP residence confidence scoring を定義する。
- Student Aid Program の metadata model を定義する。
- Privacy / on-chain raw data 禁止方針を明記する。

完了条件:

- Disaster verifier と Membership verifier の責務が分離されている。
- Pass metadata update が generic Claim / Payout に接続できる。

### 2. shared type placeholder

対象:

- `nautilus/verifiers/membership/shared/`

やること:

- `ResidenceMetadataUpdate`
- `StudentMetadataUpdate`
- `PassMigrationResult`
- `ConfidenceLevel`
- `RiskBucket`
- `EvidenceSnapshot`
- verifier family / version constants

完了条件:

- TypeScript typecheck が通る。
- raw evidence field を shared output type に含めない。

### 3. residence fixture placeholder

対象:

- `nautilus/verifiers/membership/fixtures/residence/`

やること:

- self declaration fixture
- coarse check-in hash fixture
- local interaction proof hash fixture
- expected `ResidenceMetadataUpdate`
- low / medium / high confidence cases

完了条件:

- fixture から expected metadata update が説明できる。
- raw phone、GPS history、detailed address を含めない。

### 4. student fixture placeholder

対象:

- `nautilus/verifiers/membership/fixtures/student/`

やること:

- school proof hash fixture
- term / semester fixture
- school region hash fixture
- expected `StudentMetadataUpdate`
- verified / probable / rejected cases

完了条件:

- fixture から expected metadata update が説明できる。
- raw school email、student id、document image を含めない。

### 5. residence dummy verifier

対象:

- `nautilus/verifiers/membership/verifiers/residence/`

やること:

- fixture input を読む dummy verifier を作る。
- deterministic confidence scoring を実装する。
- `ResidenceMetadataUpdate` を出力する。
- signature は最初は mock / unsigned output でよい。

完了条件:

- fixture から deterministic output が得られる。
- low / medium / high confidence test が通る。
- raw evidence を output に含めない。

### 6. student dummy verifier

対象:

- `nautilus/verifiers/membership/verifiers/student/`

やること:

- fixture input を読む dummy verifier を作る。
- deterministic student status / confidence を出力する。
- `StudentMetadataUpdate` を出力する。
- signature は最初は mock / unsigned output でよい。

完了条件:

- fixture から deterministic output が得られる。
- verified / probable / rejected test が通る。
- raw evidence を output に含めない。

### 7. metadata signing

対象:

- `nautilus/verifiers/membership/tee/`
- `nautilus/verifiers/membership/shared/`

やること:

- metadata update canonical payload を固定する。
- signing intent を定義する。
- local dev key で signature を生成する。
- freshness / expiry / verifier version を必須にする。

完了条件:

- Residence / Student metadata update の signed fixture が生成できる。
- replay 防止に必要な nonce または deterministic update id が定義されている。

### 8. contracts integration

対象:

- `contracts/sources/metadata_verifier.move`
- `contracts/sources/membership.move`
- `contracts/tests/`

やること:

- verifier key registry を追加する。
- Residence / Student metadata update signature を検証する。
- Pass metadata を更新する。
- expired / replay / disabled verifier を拒否する。

完了条件:

- contracts tests で valid update / invalid signature / expired / replay を検証できる。
- Claim は Nautilus 署名済み metadata だけを支払い判定に使う。

### 9. dapp registration flow

対象:

- `dapp/`
- optional scripts

やること:

- Pass registration UI。
- residence evidence submission UI。
- student evidence submission UI。
- metadata refresh UI。
- Pass status / metadata freshness 表示。

完了条件:

- ユーザーが Pass を作成し、metadata refresh を実行できる。
- raw evidence がオンチェーン transaction argument に直接入らない。

## Later Implementation Phases

- Rust / Nautilus TEE implementation。
- AWS runner integration。
- encrypted evidence storage。
- production residence data provider integration。
- school API integration。
- multi-verifier quorum。
- Pass migration production flow。
- dispute / manual review workflow。

## Quality Gate

docs-only:

- Markdown 見出し階層を確認する。
- Mermaid fence を確認する。
- raw 個人情報をオンチェーンに出す表現がないことを `rg` で確認する。

implementation:

- `pnpm check`
- `pnpm typecheck`
- `pnpm test`
- membership verifier unit tests
- `git diff --check`

## 最初のゴール

最初の実装ゴールは、以下の local deterministic slice である。

```txt
residence fixture
  -> dummy residence verifier
  -> ResidenceMetadataUpdate
  -> expected output comparison

student fixture
  -> dummy student verifier
  -> StudentMetadataUpdate
  -> expected output comparison
```

この slice で metadata shape と privacy boundary を固定してから、signature、contracts integration、dapp registration flow に進む。
