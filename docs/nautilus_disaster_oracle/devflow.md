# Sonari Nautilus Disaster Oracle 開発フロー

この文書は `nautilus/verifiers/disaster/` 配下だけの開発順序を定義する。`contracts/`、`dapp/`、`packages/` の実装は対象外である。ただし、Payload、Merkle leaf、source manifest は root `schemas/` を外部契約として参照する。

Disaster verifier の責務は、災害イベントと対象セル root の作成に限定する。Membership Pass、residence verifier、student verifier、個人の受取資格判定は対象外であり、`nautilus/verifiers/membership/` と contracts の generic claim flow で扱う。

## 開発方針

- root `schemas/` を Step 0 として最初に固定し、Oracle 側はその契約に合わせて実装する。
- BCS Payload field order、enum 値、integer encoding、`AffectedCellLeaf` hash 順序は変更しない。
- 先に pure な Oracle core を作り、Cloudflare、AWS、Nautilus / TEE は後から接続する。
- Worker は候補検出と状態管理だけを担当し、finalize 判定、H3 生成、hash、BCS、署名は行わない。
- Fixture は人間が期待値を確認できる最小 grid から始める。
- Oracle Core はまず署名なし Payload 生成まで作り、hash / root が安定してから local 署名を追加する。
- TEE 化の前に、通常の Rust CLI と Node script E2E で同じ出力を再現できる状態にする。
- `finalized` Payload だけを Relayer に渡す。`pending_source`、`pending_mmi`、`rejected`、`ignored_small` は D1 状態として扱う。
- 外部サービス接続は adapter 境界に閉じ、core logic は fixture と unit test で検証できるようにする。
- 個人の residence / student metadata update、Pass migration、EligibilityResult 生成はこの devflow に含めない。

## 推奨順序

### 0. Root schemas を固定する

対象:

- `schemas/disaster_oracle_response.bcs.md`
- `schemas/affected_cell_leaf.md`
- `schemas/affected_cells.schema.json`
- `schemas/source_manifest.schema.json`
- `schemas/raw_data_manifest.schema.json`
- `schemas/examples/`

やること:

- BCS Payload の field order、enum 値、integer encoding を固定する。
- Affected cell leaf の hash 対象 field と sort rule を固定する。
- `source_manifest`、`raw_data_manifest`、`affected_cells` の canonical JSON ルールを固定する。
- `event_uid`、`source_set_hash`、`raw_data_hash`、`affected_cells_data_hash`、Merkle root の hash 仕様を固定する。
- golden vector で canonical JSON、hash、Merkle proof、unsigned BCS Payload bytes を検証可能にする。

完了条件:

- Oracle 実装中に field order、enum 値、hash 対象 field を変更しなくてよい。
- `oracle_version = 1` の Payload field order は immutable contract として扱う。

### 1. ディレクトリと共有型を用意する

対象:

- `nautilus/verifiers/disaster/shared/`
- `nautilus/verifiers/disaster/fixtures/`
- `nautilus/verifiers/disaster/tee/`
- `nautilus/verifiers/disaster/watcher/`
- `nautilus/verifiers/disaster/relayer/`

やること:

- status、error code、source、cell metric、generation method などの定数を定義する。
- status に `ignored_small`、error code に `WATCHER_BELOW_AUTO_THRESHOLD` を追加する設計にする。
- Worker、TEE core、Relayer の入出力型を分ける。
- root `schemas/` の enum 値、field order、hash 仕様を実装側の型へ写す。
- `watcher` / `relayer` は `@sonari/oracle-shared` を `workspace:*` で参照する。

完了条件:

- 各コンポーネントの責務と入出力型が決まっている。
- Worker から core logic へ信頼済み値を渡さない設計になっている。
- `ignored_small` と `WATCHER_BELOW_AUTO_THRESHOLD` の意味が shared 型・D1 状態・runner 対象判定で一貫している。

### 2. Fixture と golden output を作る

対象:

- `nautilus/verifiers/disaster/fixtures/`

やること:

- USGS detail GeoJSON fixture を置く。
- ShakeMap `grid.xml` または `grid.xml.zip` の小さな再現 fixture を置く。
- 最初の grid は、人間がセル数、MMI、Band、P90 を目視確認できる最小サイズにする。
- expected `source_manifest`、`affected_cells`、`affected_cells_root`、`affected_cells_data_hash`、`raw_data_hash` を用意する。

完了条件:

- 同じ fixture から同じ hash、Merkle root、affected cells が再現できる。
- pending / rejected / finalized の代表ケースを fixture で確認できる。

### 3. TEE ではない Rust Oracle Core を作る

対象:

- `nautilus/verifiers/disaster/tee/`

やること:

- まずは Nautilus / TEE 依存なしの Rust library / CLI として実装する。
- USGS detail の `products.shakemap` を確認する。
- ShakeMap grid を読み、H3 resolution 7 に `GRID_POINT_P90` で集約する。
- `cell_band`、`severity_band`、`affected_cells` を決める。
- `source_set_hash`、`raw_data_hash`、`affected_cells_data_hash`、`affected_cells_root` を生成する。
- まずは署名なし BCS Payload を生成する。
- hash、Merkle root、BCS bytes が安定してから、ローカル開発鍵による署名を追加する。

完了条件:

- fixture 入力から署名なし finalized payload を生成できる。
- hash / root / BCS bytes が golden output と一致する。
- pending / rejected ケースでは payload と signature を生成しない。

### 4. Relayer を dry-run から実装する

対象:

- `nautilus/verifiers/disaster/relayer/`

やること:

- finalized signed payload を読み込む。
- Payload を変更せず、投稿単位として扱う。
- まずは dry-run で payload validation、Move entry argument 形式への変換、submit request 作成まで実装する。
- その後、Sui SDK 投稿 adapter を接続する。

完了条件:

- finalized payload だけが投稿対象になる。
- dry-run 出力で Move entry 関数に渡す argument 形式を確認できる。
- 再試行しても payload 内容が変わらない。

### 5. Watcher を local / mock runner で実装する

対象:

- `nautilus/verifiers/disaster/watcher/`

やること:

- Cloudflare Worker、Wrangler、D1 migration を用意する。
- Cron で USGS recent earthquakes API を取得する。
- 過去 60 分の `type === "earthquake"` event id を重複スキャンし、`source_event_id` の冪等管理を実装する。
- USGS recent feed summary fields の `mag`、`mmi`、`alert`、`tsunami` を parser / D1 upsert 境界で保持する。
- D1 upsert 時に summary auto-screening を実行し、`new` / `ignored_small` を分ける。
- `ignored_small` は due query、runner、TEE 起動対象から除外する。
- 後続 summary update で条件を満たした `ignored_small` event だけを `new` へ昇格する。
- 手動投入 API は summary auto-screening を bypass して runner 対象にできる。

完了条件:

- `new`、`processing`、`pending_source`、`pending_mmi`、`finalized`、`submitted`、`failed`、`rejected`、`ignored_small` の遷移を D1 で追跡できる。
- Worker は finalize 判定や Payload 生成をしていない。

### 6. Node script で Local end-to-end を通す

対象:

- `watcher/`
- `tee/`
- `relayer/`
- `scripts/`

やること:

- Fixture event id から Watcher 相当の orchestration を起動する。
- Node script が local Oracle Core を呼ぶ。
- Oracle Core が finalized payload または pending / rejected status を返す。
- finalized の場合だけ Relayer dry-run に渡し、Move entry argument 形式まで出力する。
- D1 更新は最初は mock repository でよい。

完了条件:

- Node script だけで Watcher orchestration -> Oracle Core -> Relayer dry-run まで通る。
- 同じ `source_event_id` を再投入しても二重処理にならない。

### 7. Wrangler local へ接続する

対象:

- `watcher/`
- `tee/`
- `relayer/`

やること:

- Node script で固めた orchestration を Cloudflare Worker local 環境へ接続する。
- local runner adapter 経由で Oracle Core を呼ぶ。
- D1 local に status、error_code、retry_count、source_updated_at_ms を保存する。
- finalized の場合だけ Relayer dry-run に渡す。

完了条件:

- Cloudflare local 環境で Watcher -> Oracle Core -> Relayer dry-run まで通る。
- D1 local に処理履歴と失敗理由が残る。

### 8. Nautilus / TEE 境界へ移す

対象:

- `nautilus/verifiers/disaster/tee/`

やること:

- Rust Oracle Core の pure logic は維持し、Nautilus / TEE 用 entrypoint を薄く追加する。
- 署名鍵を TEE 側に隔離する。
- Worker から受け取る入力は `source_event_id`、`hazard_type`、`primary_source`、`geo_resolution` の最小セットにする。
- TEE 内で USGS detail と ShakeMap を再取得する。

完了条件:

- TEE 外で生成した fixture 結果と、TEE entrypoint 経由の結果が一致する。
- Worker が渡した hash、root、Band、Payload を信用していない。
- finalized の場合だけ TEE 署名が付く。

### 9. AWS Runner と Queue を接続する

対象:

- `watcher/`
- `tee/`

やること:

- Worker から AWS Nautilus runner 起動 API を呼ぶ。
- Cloudflare Queues を使う場合は、起動 job と retry を分離する。
- runner timeout、起動失敗、TEE 失敗を D1 `error_code` に保存する。
- Payload 生成後、runner を停止する。

完了条件:

- 候補検出時だけ runner を起動できる。
- timeout / retry 上限 / failed status が運用上追える。
- runner 停止漏れを検出できる。

### 10. Live source で検証する

対象:

- `watcher/`
- `tee/`
- `relayer/`

やること:

- USGS recent earthquakes の live scan を行う。
- manual API で既知の USGS event id を再処理する。
- ShakeMap あり、ShakeMap 未公開、閾値未満、cancelled のケースを確認する。
- Relayer はまず dry-run、最後に実投稿 adapter を有効化する。

完了条件:

- live source でも fixture と同じ責任分界で処理できる。
- finalized 以外は投稿されない。
- D1 の状態だけで処理履歴と失敗理由を追跡できる。

## 後回しにするもの

- residence verifier。
- student verifier。
- Pass metadata update。
- Pass migration。
- generic EligibilityResult generation。
- 複数 AWS Region / 複数 Enclave fallback。
- manual review status。
- HDF area weighted 集約。
- Worker による Band 推定。
- Relayer による Payload 補正。

## Implementation follow-up TODO

次 PR では docs-only ではなく実装として以下を反映する。

- shared status / error code に `ignored_small` と `WATCHER_BELOW_AUTO_THRESHOLD` を追加する。
- watcher parser で `mag`、`mmi`、`alert`、`tsunami` を保持する。
- D1 upsert 時に summary auto-screening を実行する。
- due 対象と runner / TEE 起動対象から `ignored_small` を除外する。
- 後続 summary update による `ignored_small -> new` 昇格を実装する。
- manual submit の summary auto-screening bypass を維持する。
- threshold 境界値、null / 不正値、`ignored_small` 除外、昇格、manual submit bypass のテストを追加する。

## 最初のゴール

最初の実装ゴールは、以下の local vertical slice である。

```txt
USGS fixture
  -> Rust Oracle Core
  -> affected_cells.json
  -> affected_cells_root
  -> unsigned BCS finalized payload
  -> hash / root / BCS golden output check
  -> local signature
  -> Relayer dry-run
  -> Move entry argument output
  -> mock status update
```

この流れを Node script で安定させてから、Wrangler local、Nautilus / TEE、AWS runner、Cloudflare Queue、live source を順番に接続する。
