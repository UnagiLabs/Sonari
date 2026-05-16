# Sonari Nautilus Earthquake Oracle 要件定義

Sonari Earthquake Oracle は、地震データをNautilus / TEE内で再検証し、Sui Moveで検証可能な署名付きDisasterEvent Payloadへ変換する層です。

## 主なワークフロー

1. Cloudflare CronがCloudflare Workerを起動する。
2. WorkerがUSGS recent earthquakes APIを取得する。
3. Workerが `type === "earthquake"` のevent idをD1へ冪等記録し、summary fieldsで軽量screeningする。
4. Workerがauto-screeningを通過したeventだけ、または手動投入されたeventだけをNautilus runnerへ渡す。
5. Nautilus / TEEがUSGS詳細を再取得・再検証する。
6. Nautilus / TEEがBand、H3 cell、Merkle root、監査hash、BCS Payload、署名を生成する。
7. Relayerが `finalized` の署名付きPayloadだけをSui Moveへ投稿する。
8. Moveが署名、intent、freshness、revision、source、rootを検証してDisasterEventを作成する。

## このワークフローの要点

- Workerは軽量Watcherであり、USGS recent feedのearthquake event id記録、状態管理、auto-screening、Nautilus起動だけを担当する。
- Nautilus / TEEは最終判定者として、外部sourceを再取得し、Band判定、H3生成、Payload生成、署名を行う。
- `pending_source` / `pending_mmi` / `rejected` / `ignored_small` はoffchain D1 stateだけで管理し、Suiへ投稿しない。
- Magnitude / summary MMI / alert / tsunami はTEE起動対象を絞るWatcher運用フィルタであり、DisasterEvent finalize条件ではない。
- Relayerは単なる配送係であり、`finalized` Payloadだけを投稿する。MoveはRelayerやWorkerを信頼しない。
- Moveは登録済みNautilus / TEE署名済みの `finalized` Payloadだけを検証し、DisasterEventをClaim接続対象にする。

## 目的

USGSなどの地震データをもとに、対象地域・揺れの強さ・監査用hash・対象H3 cell rootを確定し、Sui上のDisasterEvent作成へ接続します。

この文書では、MVPで実装判断に必要な責任分界、構成、データ要件、Move検証要件だけを定義します。

## MVP対象

- 対象災害は地震のみ。
- MagnitudeのみではDisasterEventをfinalizeしない。
- USGS recent feedの `type === "earthquake"` event idは、summary auto-screeningの結果にかかわらず原則D1へ記録する。
- 最終Band判定はUSGS MMI / ShakeMap、または日本デモ用のJMA震度で行う。
- `finalized` のDisasterEventのみClaim接続可能にする。
- H3 resolutionは7固定。
- `affected_cells` はH3セルごとの `cell_band >= 1` の集合にする。
- 速報性より判定安定性を優先し、災害発生から3日以内に送金できればよい。

## 信頼境界

- Cloudflare Workerは候補地震を見つけてNautilusを起動する係であり、最終判定者ではない。
- Nautilus / TEEは外部sourceを再取得・再検証し、Payload生成と署名を行う。
- Relayerは信用しない。Moveは署名付きPayloadだけを検証対象にする。
- MoveはWorkerを一切信頼しない。

## 1. MVP方針

Sonari Disaster Oracle v1は、地震の発生そのものではなく「対象地域がどれくらい揺れたか」を検証可能にすることを目的にします。

| 項目 | 方針 |
| --- | --- |
| MVP災害 | 地震のみ |
| 候補検出 | Cloudflare WorkerがUSGS recent earthquakes APIを定期取得し、`type === "earthquake"` をD1へ記録 |
| Runner起動フィルタ | Workerがsummary fieldsでauto-screeningし、TEE起動対象を絞る |
| 最終検証 | Nautilus / TEEがUSGS詳細を再取得して実施 |
| セル生成方式 | 初期MVPからcell_intensity方式を採用 |
| Band判定 | H3セルごとのUSGS MMIまたはJMA震度で判定 |
| Magnitude | Watcher auto-screeningには使うがfinalize条件には使わない |
| Claim接続 | `finalized` のみ許可 |
| H3 | resolution 7固定 |
| affected_cells | `cell_band >= 1` のH3セル集合 |
| raw data | `raw_data_hash` は必須、`raw_data_uri` はMVPではoptional |
| TEE | AWS EC2 / Nitro Enclaves上のNautilus実行環境。常時起動せず、候補検出時のみ起動する |

## 2. 補足: 全体構成

```txt
Cloudflare Cron Trigger
  -> Cloudflare Worker: Sonari Earthquake Watcher
  -> USGS recent earthquakes API
  -> Cloudflare D1 / Queue
  -> 必要時のみ AWS EC2 + Nautilus / TEE 起動
  -> Nautilus内で詳細検証・署名
  -> Relayer
  -> Sui Move
```

MVPでは、Cloudflare Workerを常時稼働の軽量Watcherとして使います。AWS EC2 / Nautilus / TEEは重い検証・署名環境であり、候補地震が見つかった時だけ起動API経由で呼び出します。この図は冒頭ワークフローの実行基盤を補足するものです。

## 3. 責任分界

### Cloudflare Workerがやること

- Cloudflare Cron Triggerで3〜5分ごとに起動する。
- USGS recent earthquakes APIを取得する。
- 過去60分の `type === "earthquake"` event idを重複スキャンする。
- `source_event_id` による冪等管理を行う。
- D1にイベント状態を保存する。
- USGS recent feed summary fieldsの `mag`、`mmi`、`alert`、`tsunami` を保存し、auto-screeningで `new` と `ignored_small` を分ける。
- threshold未満の地震は `ignored_small` + `WATCHER_BELOW_AUTO_THRESHOLD` としてD1に残し、runner / TEEには渡さない。
- 後続のUSGS summary updateでauto-screening条件を満たした場合のみ、`ignored_small` から `new` へ昇格する。
- Cloudflare Queueを使う場合はNautilus起動ジョブを投入する。
- auto-screeningを通過した地震、または手動投入された地震だけAWS Nautilus runner起動APIを呼ぶ。
- `pending_source` / `pending_mmi` の再チェック予定を管理する。
- 手動投入APIで `source_event_id` を受け付け、summary auto-screeningをbypassしてrunner対象にできる。
- Worker失敗、AWS runner起動失敗、timeout、TEE処理失敗、再試行上限到達をD1の `error_code` に保存し、admin通知対象にする。

### Cloudflare Workerがやらないこと

- DisasterEventをfinalizeしない。
- auto-screening結果をDisasterEvent finalizationとして扱わない。
- Magnitude、summary MMI、alert、tsunamiだけでClaim対象かどうかを判断しない。
- Band最終判定をしない。
- H3 cellを生成しない。
- Merkle rootを生成しない。
- BCS Payloadを生成しない。
- TEE署名をしない。
- SuiへDisasterEventを直接作成しない。

### Nautilus / TEEがやること

- Workerから受け取った `source_event_id` をもとにUSGS詳細を再取得する。
- 通常は `ignored_small` を受け取らない。ただし手動投入などでWatcher screeningをbypassされた場合は、従来通りUSGS詳細を再取得・検証する。
- USGS detail GeoJSONの `products.shakemap` を確認し、ShakeMap productの最新版を特定する。
- ShakeMapが未公開の場合はfinalizeせず、`pending_source` として再チェック対象にする。
- MVP live sourceとしてUSGS ShakeMap `grid.xml.zip` を取得・照合する。
- source freshness、source更新時刻、許可sourceを検証する。
- raw source dataから `raw_data_hash` を生成する。
- H3 resolution 7の候補セルを生成する。
- 各H3セルに対してUSGS MMIを集約する。
- 各H3セルの `cell_band` を決定する。
- `cell_band >= 1` のセルを `affected_cells` に採用する。
- `severity_band = max(cell_band)` を決定する。
- D1へ返すoffchain statusとして `pending_source` / `pending_mmi` / `finalized` / `rejected` を決定する。
- Claim対象セルだけの `affected_cells_root` を生成する。
- `source_set_hash` を生成する。
- Moveと同じ構造のBCS Payloadを生成する。
- `finalized` の場合だけ、Nautilus / TEE内の秘密鍵でPayloadに署名する。

### Relayerがやること

- Nautilus / TEEが生成した `finalized` 署名付きPayloadをSui Moveへ送信する。
- Payloadの内容を変更しない。
- 信頼対象ではないため、Move検証を通らないPayloadは無効になる。

### Sui Moveがやること

- Nautilus署名済みの `finalized` Payloadだけを検証する。
- entry関数は `create_finalized_disaster_event_from_sonari` のようにfinalized専用であることが伝わる名前にする。
- `pending_source` / `pending_mmi` / `rejected` をオンチェーンObjectとして作成しない。
- 古いrevision、期限切れPayload、許可されていないsourceを拒否する。
- `affected_cells_root`、`affected_cells_uri`、`affected_cells_data_hash` を保存し、Claim側のMerkle proof検証へ接続する。
- Claim時に提出される `AffectedCellLeaf` とMerkle proofを検証する。
- Claim対象セルの `h3_index` がユーザーまたは物件所在地のH3セルと一致することを検証する。
- `cell_band >= min_claim_band` と商品・保険プラン側の要求Bandを検証する。

### Sui Moveがやらないこと

- ShakeMap取得。
- MMI計算。
- H3 polygon変換。
- p90集約。
- 地理計算。

## 4. 技術スタックと各プログラム

MVPでは、責任分界をそのままプログラム境界に対応させます。実装コードやpackage manifestはこの文書では追加せず、採用方針だけを定義します。

| 対象 | 採用技術 | 役割 |
| --- | --- | --- |
| `nautilus_disaster_oracle/watcher/` | Cloudflare Workers、TypeScript、Wrangler | Cron、USGS recent earthquakes API取得、D1状態管理、Queue投入、AWS起動API呼び出し、手動投入API |
| `nautilus_disaster_oracle/tee/` | Rust、Nautilus、serde、reqwest、bcs、sha2、h3oまたはh3ron | USGS詳細再取得、セル別震度集約、Band判定、H3生成、Merkle root生成、監査hash生成、BCS Payload生成、TEE署名 |
| `nautilus_disaster_oracle/relayer/` | TypeScriptまたはRust、Sui SDK | 署名済みPayloadのSui投稿、投稿結果の記録、再試行 |
| `nautilus_disaster_oracle/shared/` | TypeScript | Oracle内部の共有型、定数、validator |
| `nautilus_disaster_oracle/fixtures/` | JSON | USGS / JMAの再現用サンプルデータ、TEE・Watcher・Relayerの共通テスト入力 |
| `contracts/` | Sui Move | 署名Payload検証、revision管理、DisasterEvent Object作成、Claim接続用root保存 |
| `dapp/` | React / Next.js、TypeScript、Sui dApp Kit | Dashboard、Claim、DisasterEvent表示、Wallet接続 |
| `packages/` | TypeScript | 全体共有のUI / configのみ。Oracle専用コードは置かない |
| `scripts/` | shellまたはTypeScript補助スクリプト | ローカル実行、TEEデプロイ、Enclave登録、Payload投稿 |
| storage / queue | Cloudflare D1、Cloudflare Queues、optional R2 | 候補地震のprimary state、TEE起動ジョブ管理、必要に応じたwatcher snapshot保存 |
| TEE / runtime | AWS EC2 / Nitro Enclaves、Nautilus | Nautilus実行環境、秘密鍵隔離、署名生成。候補検出時のみ起動し、Payload生成後に停止 |

## 5. DisasterEvent判定方針

DisasterEventのfinalize条件にはMagnitudeを使いません。Magnitude、USGS summary MMI、alert、tsunamiはWatcher auto-screeningにだけ使い、Claim接続可否はTEEが再取得したsourceとcell-level Bandで判断します。

Band判定はイベント全体ではなく、H3セルごとの揺れ強度を基準にします。

| Cell Band | USGS MMI | JMA震度 | Moveでの扱い |
| --- | --- | --- | --- |
| Band 0 | MMI VII未満 | 震度6弱未満 | Claim対象外 |
| Band 1 | MMI VII以上 | 震度6弱 | Claim対象 |
| Band 2 | MMI VIII以上 | 震度6強 | Claim対象 |
| Band 3 | MMI IX以上 | 震度7 | Claim対象 |

```txt
affected_cells = all H3 cells where cell_band >= 1
event.severity_band = max(cell.cell_band)
```

`severity_band` はイベント全体の最大Bandです。同じ地震イベント内でも、H3セルごとにBand 1 / 2 / 3が混在し得ます。

Claim可否は、ユーザーまたは物件所在地のH3セルが `affected_cells_root` に含まれ、かつ必要Band以上であることで判定します。

### Source優先順位

| 優先度 | Source | 用途 |
| --: | --- | --- |
| 1 | USGS ShakeMap MMI grid | MVP live source。グローバル標準のセル別MMI判定 |
| 2 | JMA推計震度分布 | 日本デモ用fixture。本番parserはCould要件 |
| 3 | JMA観測点震度 | Future補助source |
| 4 | USGS event summary `properties.mmi` | fallback。イベント全体の参考値 |
| 5 | Magnitude / 震源情報 | Watcher auto-screening・初期テストのみ。finalize根拠にはしない |

MVPのlive sourceはUSGSのみです。JMAは日本デモ用fixtureとして扱い、JMA本番parserはCould要件にします。

USGS ShakeMapは、対象となる大規模地震では原則利用可能と期待します。ただしOracleはShakeMapの存在を前提にfinalizeしてはいけません。必ずUSGS detail GeoJSONの `products.shakemap` を確認し、取得できない場合は `pending_source` として再チェックします。

`properties.mmi` はイベント全体の参考値です。セル単位のleafを生成できない場合は、Claim可能な `affected_cells_root` の主根拠にはしません。

### H3セルへの震度集約

```txt
H3 resolution: 7
Cell intensity source: USGS MMI
Cell aggregation: GRID_POINT_P90
Cell inclusion: cell_band >= 1
Event band: max(cell_band)
```

MVPでは、USGS ShakeMap `grid.xml.zip` の格子点MMIをH3 resolution 7へ割り当て、各H3セル内のMMI値からP90を取る `GRID_POINT_P90` を標準にします。厳密な面積重み付き計算ではないため、MVP名にはarea weightedを使いません。

将来の高精度方式として、USGS ShakeMap HDFを使う `shakemap_hdf_h3_area_weighted_p90_v1` を検討できます。

ShakeMapなどのsource自体がまだ取得できない場合、Nautilus / TEEはDisasterEventをfinalizeせず `pending_source` とします。sourceは取得できたがセル単位の揺れ強度がまだ確定できない場合は `pending_mmi` とします。

| Status | 意味 | Claim接続 |
| --- | --- | --- |
| `pending_source` | ShakeMapなどのsourceがまだ取得できない | 不可 |
| `pending_mmi` | sourceはあるが、セル単位の揺れ強度が未確定 | 不可 |
| `finalized` | cell_band、affected_cells_root、raw_data_hash、source_set_hashが確定 | 可 |
| `rejected` | TEE/Coreが検証した結果、対象外またはfinalize不可 | 不可 |
| `ignored_small` | Watcher auto-screeningでthreshold未満としてrunner / TEE起動をskip | 不可 |

MVPでは、`pending_source` / `pending_mmi` / `rejected` / `ignored_small` はD1内だけで管理します。Suiへ投稿するのは `finalized` Payloadのみです。`ignored_small` はfinalization結果ではなく、Watcher運用上のTEE起動skipです。

`event_uid` は同じ地震で固定します。D1の `latest_revision` はoffchain状態管理用であり、Moveへ投稿する `event_revision` はTEEがsource manifestから決定します。Move側は同一 `event_uid` で最初に受理したSonari Finalized RevisionをClaim対象にします。MVPでは同一 `event_uid` が受理済みなら後続投稿を拒否し、差額支払い、減額、返金、top-up claimは対象外です。

将来拡張として、後続revisionで新しく対象になった地域へのtop-up claimを検討できます。

### Sonari Earthquake Finalization Rule v1

速報性より判定の安定性を優先します。

1. WorkerはUSGS recent feedから `type === "earthquake"` のevent idをD1へ保存する。
2. Workerはauto scan時にsummary fieldsで軽量screeningを行う。
3. thresholdを満たす場合は `status = new` にする。
4. threshold未満の場合は `status = ignored_small` + `error_code = WATCHER_BELOW_AUTO_THRESHOLD` にする。
5. `ignored_small` はrunner / TEEに渡さず、Suiへ投稿しない。
6. `new` のみ24時間後以降にrunner / TEE対象になる。
7. Magnitude、summary MMI、alert、tsunamiはfinalize条件ではなく、TEE起動対象を絞るためだけに使う。
8. TEEは発生から24時間未満の地震をfinalizeしない。
9. 24時間後、TEEがUSGS detail GeoJSONとShakeMapを再取得する。
10. `products.shakemap` のpreferred/latest productを確認する。
11. `grid.xml.zip` を取得し、MMI gridを読む。
12. H3 resolution 7へ `GRID_POINT_P90` で集約する。
13. `cell_band >= 1` のセルが1つ以上あればfinalized候補にする。
14. `map-status` が `REVIEWED` なら即finalizedにする。
15. `map-status` が `RELEASED` の場合は、48時間まで再チェックできる。
16. 48時間時点でも `RELEASED` のみであれば、その時点のlatest ShakeMapをSonari Finalized Revisionとして採用する。
17. 72時間以内にShakeMap / MMIが取得できなければ、`status = rejected` + `error_code = REJECTED_AUTO_TRIGGER` に固定する。
18. `map-status` が `CANCELLED` の場合はfinalize不可とし、`rejected` + `error_code = SHAKEMAP_CANCELLED` にする。
19. Suiへ投稿するのは `finalized` Payloadのみ。

USGSの完全な最終版を待つのではなく、Sonari独自のSonari Finalized Revisionとして確定します。manual reviewはFuture扱いであり、MVPのD1 statusにもMove Objectにも含めません。

72時間締切はD1上のfinalization deadlineです。`freshness_deadline_ms` は署名済みPayloadをMoveへ投稿できる期限であり、finalization deadlineとは別物です。MVP初期値は `observed_at_ms + 6 hours` とします。

### Watcher auto-screening

WatcherはUSGS recent feedの `type === "earthquake"` event idを原則すべてD1へupsertします。そのうえで、recent feed summary fieldsだけを使ってTEE起動対象を絞ります。このscreeningはDisasterEventの最終判定ではなく、Nautilus / TEEを起動するかどうかの運用フィルタです。

TEE起動対象は次のいずれかを満たすeventです。

```txt
mag >= 5.5
OR mmi >= 6.0
OR alert IN ("yellow", "orange", "red")
OR tsunami == 1
```

`mag`、`mmi`、`alert`、`tsunami` がnull、不正値、未知値の場合は、その条件だけを不一致として扱います。全条件が不一致の場合、Watcherは `status = ignored_small`、`error_code = WATCHER_BELOW_AUTO_THRESHOLD`、`next_retry_at_ms = NULL`、`finalization_deadline_at_ms = occurred_at_ms + 72h` としてD1に保存します。

`ignored_small` はrunner / TEEへ渡さず、Suiへ投稿せず、Claim接続不可です。`rejected` はTEE/Core検証後の対象外またはfinalize不可を表すため、Watcher段階のskipである `ignored_small` とは区別します。`ignored_small` はterminal / due対象外statusとして扱いますが、後続のUSGS summary updateでscreening条件を満たした場合のみ `ignored_small -> new` への昇格を許可します。

manual submitはsummary auto-screeningをbypassできます。手動投入された任意の `source_event_id` はrunner対象にでき、Nautilus / TEEが従来通りdetail再取得・検証を行います。

### D1状態管理

D1をMVPのprimary stateにします。KVは今回のMVPでは使いません。

```sql
CREATE TABLE IF NOT EXISTS earthquake_events (
  source_event_id TEXT PRIMARY KEY,
  event_uid TEXT,
  status TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at_ms INTEGER,
  finalization_deadline_at_ms INTEGER,
  latest_revision INTEGER DEFAULT 0,
  last_seen_at_ms INTEGER NOT NULL,
  source_updated_at_ms INTEGER,
  error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_earthquake_events_status_next_retry
  ON earthquake_events (status, next_retry_at_ms);

CREATE INDEX IF NOT EXISTS idx_earthquake_events_updated
  ON earthquake_events (updated_at_ms);
```

MVPのstatusは `new` / `processing` / `pending_source` / `pending_mmi` / `finalized` / `submitted` / `failed` / `rejected` / `ignored_small` です。manual review用statusは作りません。AWS runner起動失敗、timeout、TEE処理失敗、Relayer失敗、Move拒否は `error_code` に保存し、admin通知対象にします。

このdocs更新ではD1 schema変更は行いません。`ignored_small` は既存の `status` TEXTに保存し、summary fieldsの保持カラム追加やmigrationは実装PRで扱います。

| Status | 意味 | due対象 | runner / TEE | terminal / completed | Claim接続 |
| --- | --- | --- | --- | --- | --- |
| `new` | runner起動待ち | 可 | 渡す | いいえ | 不可 |
| `processing` | runner / TEE処理中 | 不可 | 渡さない | いいえ | 不可 |
| `pending_source` | source公開待ち | 可 | 渡す | いいえ | 不可 |
| `pending_mmi` | sourceはあるがセル単位MMI未確定 | 可 | 渡す | いいえ | 不可 |
| `finalized` | 署名付きPayload生成済み | 不可 | 渡さない | はい | 可 |
| `submitted` | Sui投稿済み | 不可 | 渡さない | はい | 可 |
| `failed` | 一時失敗、再試行または通知対象 | 可 | 渡す | いいえ | 不可 |
| `rejected` | TEE/Coreが検証した結果、対象外またはfinalize不可 | 不可 | 渡さない | はい | 不可 |
| `ignored_small` | Watcher auto-screeningでthreshold未満としてskip | 不可 | 渡さない | はい | 不可 |

due対象statusは `new` / `pending_source` / `pending_mmi` / `failed` です。runner / TEEに渡さないstatusは `ignored_small` / `finalized` / `submitted` / `rejected` / `processing` です。offchain completedとして扱うterminal statusは `finalized` / `submitted` / `rejected` / `ignored_small` です。

共通 `error_code` は以下を使います。

```txt
USGS_RECENT_UNAVAILABLE
USGS_DETAIL_UNAVAILABLE
SHAKEMAP_PRODUCT_MISSING
SHAKEMAP_CANCELLED
SHAKEMAP_GRID_UNAVAILABLE
SHAKEMAP_PARSE_FAILED
MMI_NOT_AVAILABLE
NO_AFFECTED_CELLS
WATCHER_BELOW_AUTO_THRESHOLD
SOURCE_STALE
SOURCE_REVISION_OLD
UNSUPPORTED_HAZARD_TYPE
TEE_SIGNATURE_FAILED
BCS_SERIALIZATION_FAILED
MERKLE_ROOT_FAILED
AWS_RUNNER_TIMEOUT
RELAYER_SUBMIT_FAILED
MOVE_REJECTED
REJECTED_AUTO_TRIGGER
```

特に自動判定周辺では以下を区別します。

| error_code | 意味 |
| --- | --- |
| `NO_AFFECTED_CELLS` | TEE/CoreがUSGS詳細とShakeMapを検証したが、Claim対象セルが1つもなかった |
| `WATCHER_BELOW_AUTO_THRESHOLD` | Watcherがsummary auto-screeningで小さい地震としてskipし、TEE/Coreを呼んでいない |
| `REJECTED_AUTO_TRIGGER` | 72h finalization deadline超過によりauto trigger処理を終了した |

## 6. データ・Payload要件

### 入力要件

Nautilus / TEEは、Workerまたは手動投入APIから最低限以下を受け取ります。

| Field | 要件 |
| --- | --- |
| `request_type` | `DETECT_BY_EVENT_ID` をMVPの基本形にする |
| `hazard_type` | `EARTHQUAKE` のみ許可 |
| `primary_source` | MVPでは `USGS` を基本にする |
| `source_event_id` | USGS event id。冪等管理と再取得の主キー |
| `geo_resolution` | 7固定 |

### 署名Payload要件

Nautilus / TEEがMoveへ渡すBCS Payloadには、少なくとも以下を含めます。

| Field | 要件 |
| --- | --- |
| `intent` | Sonari Earthquake Oracle専用intent |
| `oracle_version` | 許可された判定ロジックversion |
| `event_uid` | hazard type、source、source event id、occurred timeから決定的に生成 |
| `hazard_type` | EARTHQUAKE |
| `severity_band` | `finalized` では affected cells内の最大 `cell_band` |
| `status` | Move投稿Payloadでは `finalized` のみ |
| `event_revision` | TEEがsource manifestから決定するSonari Finalized Revision。D1 `latest_revision` とは別 |
| `occurred_at_ms` | 地震発生時刻 |
| `observed_at_ms` | Oracle観測時刻 |
| `source_updated_at_ms` | source側の更新時刻 |
| `primary_source` | 許可source名 |
| `source_set_hash` | source集合の監査hash |
| `raw_data_hash` | 元データの監査hash。Nautilus / TEE内で生成 |
| `raw_data_uri` | MVPではoptional |
| `affected_cells_root` | Claim対象セルだけのMerkle root。`cell_band >= 1` のleafのみ含める |
| `affected_cells_uri` | `finalized` では必須 |
| `affected_cells_data_hash` | 対象セル一覧ファイル全体の改ざん検知用32-byte hash |
| `geo_resolution` | 7 |
| `cells_generation_method` | MVPでは `shakemap_gridxml_h3_grid_point_p90_v1` |
| `cell_metric` | `USGS_MMI` または `JMA_SHINDO` |
| `cell_aggregation` | MVP標準は `GRID_POINT_P90` |
| `intensity_scale` | `MMI_X100` または `JMA_SHINDO_X10` |
| `max_cell_band` | affected cells内の最大Band。`severity_band` と一致 |
| `affected_cell_count` | affected cellsに含まれるH3セル数。異常に大きい場合はTEE / Workerでwarning logとadmin通知 |
| `min_claim_band` | Claim対象とする最低Band。MVPでは1 |
| `freshness_deadline_ms` | 署名済みPayloadをMoveへ投稿できる期限。MVP初期値は `observed_at_ms + 6 hours` |

`raw_data_hash`、`source_set_hash`、`affected_cells_root`、`affected_cells_data_hash` はNautilus / TEE内で生成します。Workerが渡した値は信頼しません。

`cells_generation_method` の意味は以下です。

| Method | 用途 |
| --- | --- |
| `shakemap_gridxml_h3_grid_point_p90_v1` | MVP標準。USGS ShakeMap `grid.xml.zip` の格子点MMIをH3 res7へ割り当て、セル内P90で集約 |
| `shakemap_hdf_h3_area_weighted_p90_v1` | Future。USGS ShakeMap HDFをH3 res7へ面積重み付きP90で集約 |
| `jma_250m_h3_p90_v1` | 日本デモ用fixture。JMA本番parserはCould要件 |

`source_set_hash` はcanonical source manifest JSONをhashした値です。manifestにはsource名、event id、product、product version、`map_status`、`updated_at_ms`、URL hash、`cells_generation_method`、`oracle_version` を含めます。

```json
{
  "sources": [
    {
      "name": "USGS",
      "event_id": "us7000abcd",
      "product": "shakemap",
      "product_version": "1",
      "map_status": "REVIEWED",
      "updated_at_ms": 1760000000000,
      "url_hash": "0x..."
    }
  ],
  "cells_generation_method": "shakemap_gridxml_h3_grid_point_p90_v1",
  "oracle_version": 1
}
```

### Merkle leaf要件

`affected_cells_root` はClaim対象セル証明用rootです。`cell_band >= 1` のleafだけを含め、Band 0セルは含めません。これは全ShakeMap領域の完全証明ではありません。

```rust
struct AffectedCellLeaf {
    event_uid: [u8; 32],
    event_revision: u32,
    h3_index: u64,
    geo_resolution: u8, // 7
    cell_metric: CellMetric, // USGS_MMI or JMA_SHINDO
    intensity_value: u16,
    intensity_scale: IntensityScale, // MMI_X100 or JMA_SHINDO_X10
    cell_band: u8, // affected cellsでは1..3
    cells_generation_method: u8,
    oracle_version: u64,
}
```

```txt
leaf_hash = hash(
  event_uid,
  event_revision,
  h3_index,
  geo_resolution,
  cell_metric,
  intensity_value,
  intensity_scale,
  cell_band,
  cells_generation_method,
  oracle_version
)

sort by h3_index ascending
```

leaf hashには上記全フィールドを含めます。Rust / TypeScript / Moveの型、enum値、field順序、integer encoding、hash順序は `schemas/affected_cell_leaf.md` に合わせます。

`intensity_value` は `intensity_scale` とセットで解釈します。MMI 7.23は `MMI_X100` で723、JMA震度6弱相当は `JMA_SHINDO_X10` の定義に従います。fixtureベースのテストでは、同じ入力から同じ `affected_cells_root` と `affected_cells_data_hash` が再現できることを確認します。

## 7. Move検証要件

MoveはWorker、Relayer、外部APIレスポンスを直接信頼しません。登録済みNautilus / TEE署名Payloadに対して、最低限以下を検証します。

| 検証項目 | 要件 |
| --- | --- |
| signature | 登録済みNautilus / TEE公開鍵で検証できること |
| intent | Sonari Earthquake Oracle専用intentであること |
| oracle_version | 許可versionであること |
| status | `finalized` のみDisasterEvent作成・Claim接続を許可 |
| freshness | `freshness_deadline_ms` を過ぎていないこと |
| revision | 古いrevision、同一revision再投稿を拒否 |
| hazard_type | EARTHQUAKEのみ許可 |
| severity_band | finalizedでは1〜3のみ許可 |
| primary_source | USGSなど許可sourceのみ許可 |
| source_set_hash | 空でない32-byte hashであること |
| raw_data_hash | 空でない32-byte hashであること |
| affected_cells_root | 空でない32-byte rootであること。Claim対象セルだけのrootとして扱う |
| affected_cells_uri | finalizedでは空でないこと |
| affected_cells_data_hash | finalizedでは空でない32-byte hashであること |
| affected_cell_count | finalizedでは0より大きいこと。異常値上限はMoveでは検証しない |
| min_claim_band | MVPでは1であること |

Move側のDisasterEventまたはRegistryは、最低限 `event_uid`、`accepted_revision`、`source_updated_at_ms`、`affected_cells_root`、`affected_cells_data_hash` を保持します。

Claim時は、提出された `AffectedCellLeaf` とMerkle proofが `affected_cells_root` に一致することを検証します。Claim対象セルの `h3_index` はユーザーまたは物件所在地のH3セルと一致し、`cell_band >= min_claim_band` を満たす必要があります。

MoveはShakeMap取得、MMI計算、H3 polygon変換、p90集約、地理計算を行いません。

## 8. 見逃しリスク対策

Cloudflare Cronは失敗、遅延、API一時障害を前提に設計します。

- Cronは3〜5分ごとに再実行する。
- 各Cronで過去60分のUSGS recent earthquakesを重複スキャンする。
- `type === "earthquake"` の `source_event_id` はsummary auto-screening結果にかかわらずD1へupsertする。
- `source_event_id` で冪等管理し、同じeventを重複起動しない。
- 状態は `new` / `processing` / `pending_source` / `pending_mmi` / `finalized` / `submitted` / `failed` / `rejected` / `ignored_small` で管理する。
- `ignored_small` はdue対象外にし、runner / TEEには渡さない。
- 後続USGS summary updateで `mag >= 5.5`、`mmi >= 6.0`、`alert IN ("yellow", "orange", "red")`、`tsunami == 1` のいずれかを満たした場合のみ `ignored_small -> new` へ昇格する。
- `pending_source` / `pending_mmi` は再チェック予定時刻を持つ。
- 24時間未満の地震はfinalizeせず、D1の `next_retry_at_ms` で再チェックする。
- 48時間時点のlatest `RELEASED` ShakeMapはSonari Finalized Revisionとして採用できる。
- 72時間以内にShakeMap / MMIを取得できなければ `status = rejected`、`error_code = REJECTED_AUTO_TRIGGER` に固定する。
- `freshness_deadline_ms` はfinalization deadlineではなく、署名済みPayloadの投稿期限として `observed_at_ms + 6 hours` を初期値にする。
- 過去24時間の定期バックフィルをShould要件にする。
- Worker失敗、Nautilus起動失敗、再試行上限到達は通知する。
- 手動投入APIで特定 `source_event_id` を再処理できるようにし、summary auto-screeningをbypassしてrunner対象にできるようにする。

## 9. インフラ方針

TEEはAWSを使用します。AWSは軽量Watcherではなく、Nautilus / TEE実行環境として扱い、コスト削減のため常時起動しません。

- 軽量WatcherはCloudflare Workers Cron Triggerで実装する。
- MVPではEC2 / Nitro Enclavesを常時稼働させない。
- Workerがauto-screeningを通過した地震、または手動投入された地震だけ、AWS Nautilus runner起動APIを呼び、TEE実行環境を自動起動する。
- Nautilus / TEEはUSGS詳細を再取得・再検証し、署名付きPayloadを生成する。
- Payload生成とRelayerへの引き渡しが完了したら、AWS runnerを停止する。
- 起動後に一定時間ジョブが進まない場合も、失敗として記録してAWS runnerを停止する。
- Cloudflare D1をprimary stateに使う。
- Cloudflare QueuesはNautilus起動ジョブ化に使う。
- AWS Nitro Enclaves self-managedをMVPのTEE実行基盤にする。
- Could要件として、複数AWS Region / 複数Enclave fallbackを検討する。

## 10. MVP Must / Should / Could

### Must

- Cloudflare Workers Cron Trigger。
- USGS recent earthquakes API取得。
- 過去60分の重複スキャン。
- `source_event_id` 冪等管理。
- D1によるprimary state管理。
- Watcher auto-screeningによる `new` / `ignored_small` 分岐。
- `ignored_small` をrunner / TEE、Sui投稿、Claim接続から除外する。
- 後続USGS summary updateで条件を満たした場合の `ignored_small -> new` 昇格。
- WorkerからAWS Nautilus runner起動APIを呼ぶ。
- summary auto-screeningをbypassできる手動投入API。
- Workerではfinalizeせず、Nautilus / TEEが再取得・再検証する責任分界。
- USGS詳細の再取得。
- USGS detail GeoJSONの `products.shakemap` 確認。
- Sonari Earthquake Finalization Rule v1。
- MMI / `pending_source` / `pending_mmi` 判定。
- H3セルごとのBand 1〜3判定。
- H3 resolution 7固定。
- `cells_generation_method` をPayloadに含める。
- `affected_cells = cell_band >= 1` のH3セル集合。
- `affected_cells_root` はClaim対象セルだけのleafから生成する。
- MoveでClaim時のMerkle proof検証に接続できる形式にする。
- finalized event用 `affected_cells_uri`。
- finalized event用 `affected_cells_data_hash`。
- `raw_data_hash` / `source_set_hash` / `affected_cells_data_hash` 生成。
- `affected_cells_root` は `cell_band >= 1` のClaim対象セルだけで生成する。
- BCS Payload生成。
- Nautilus / TEE署名。
- Moveでsignature / intent / oracle_version / freshness / revision / hazard_type / severity_band / source / root / data hashを検証。

### Should

- `pending_source` / `pending_mmi` 再チェックスケジューリング。
- Cloudflare Queuesによるジョブ化。
- 過去24時間の定期バックフィル。
- Worker失敗・Nautilus起動失敗通知。
- JMA震度fixture。
- USGS ShakeMap `grid.xml.zip` を使った `shakemap_gridxml_h3_grid_point_p90_v1`。
- `cell_metric` / `cell_aggregation` / `intensity_scale` をPayloadに含める。
- `affected_cell_count` をPayloadに含める。
- 異常に大きい `affected_cell_count` のwarning logとadmin通知。
- 日本デモ用に `jma_250m_h3_p90_v1` fixtureを用意する。
- `raw_data_uri`。
- AWS runnerの自動起動・停止の監視とアラート。

### Could

- permissionless trigger。
- USGS + JMAなど複数Watcher source。
- R2 watcher snapshot保存。
- Durable Objectsによるロック管理。
- 複数AWS Region / 複数Enclave fallback。
- USGS ShakeMap HDF対応。
- JMA本番parser。
- 複数sourceのquorum。
- `shakemap_hdf_h3_area_weighted_p90_v1` など高精度集約方式のversion追加。
- UIでH3セルごとのBand可視化。
- Walrus保存。
- 複数Enclave quorum。

## 11. Implementation follow-up TODO

このdocs-only更新では実装コード、schemas、contracts、relayer、teeは変更しません。次PRで以下を実装対象にします。

- shared型へ `ignored_small` statusと `WATCHER_BELOW_AUTO_THRESHOLD` error codeを追加する。
- watcher parserでUSGS recent feed summary fieldsの `mag`、`mmi`、`alert`、`tsunami` を保持する。
- D1 upsert時にsummary auto-screeningを実行し、`new` / `ignored_small` を分ける。
- due queryから `ignored_small` を除外し、runner / TEEへ渡さない。
- 後続USGS summary updateで条件を満たした場合だけ `ignored_small -> new` 昇格を実装する。
- manual submitがsummary auto-screeningをbypassしてrunner対象にできる挙動を維持する。
- `ignored_small`、昇格、manual submit bypass、threshold境界値、null / 不正値のunit testを追加する。

## 12. ディレクトリ構成

`schemas/` はrepository rootに置くroot共通仕様です。Oracle実装、Relayer、Move packageが同じPayload / leaf / manifest定義を参照し、言語間の構造ズレを防ぎます。

```txt
nautilus_disaster_oracle/
  tee/
    README.md
    Cargo.toml
    src/
      main.rs
      app.rs
      config.rs
      error.rs
      api/
        mod.rs
        usgs.rs
        jma.rs
      domain/
        earthquake.rs
        trigger.rs
        geo.rs
        h3_cells.rs
        intensity_grid.rs
        cell_band.rs
        merkle.rs
        payload.rs
        source_manifest.rs
    allowed_endpoints.yaml
  watcher/
    package.json
    wrangler.toml
    migrations/
      0001_create_earthquake_events.sql
    src/
      index.ts
      usgs.ts
      state.ts
      trigger_tee.ts
      manual_submit.ts
      errors.ts
    tests/
      usgs_fixture.test.ts
  relayer/
    package.json
    src/
      index.ts
      sui.ts
      submit_payload.ts
  shared/
    src/
      types.ts
      constants.ts
      validators.ts
      errors.ts
  fixtures/
    usgs_shakemap_gridxml_mmi_vii.json
    usgs_shakemap_gridxml_mmi_viii.json
    usgs_shakemap_gridxml_mmi_ix.json
    usgs_pending_source.json
    usgs_pending_mmi.json
    jma_250m_shindo_6_lower.json
    jma_250m_shindo_6_upper.json
    jma_250m_shindo_7.json
schemas/
  disaster_oracle_response.bcs.md
  affected_cell_leaf.md
  source_manifest.schema.json
  affected_cells.schema.json
```

## まとめ

Sonari Earthquake Oracle v1は、Cloudflare WorkerでUSGS recent feedのearthquake event idをD1へ記録し、summary auto-screeningでTEE起動対象を絞り、Nautilus / TEEでセル単位の揺れ強度を再取得・再検証し、`finalized` 署名付きPayloadだけをSui Moveへ渡す最小構成にします。

Workerは起動・D1状態管理・見逃し対策・auto-screeningに限定し、DisasterEventの最終判定、H3セル別Band判定、Merkle root生成、BCS Payload生成、署名はNautilus / TEEが担います。Magnitude / summary MMI / alert / tsunami はrunner起動フィルタであり、MoveはWorkerを信頼せず、Nautilus署名Payloadのsignature / intent / oracle_version / freshness / revision / source / root / data hashを検証してDisasterEventを作成します。
