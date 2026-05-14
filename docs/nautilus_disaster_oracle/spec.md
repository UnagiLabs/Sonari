# Sonari Nautilus Earthquake Oracle 要件定義

Sonari Earthquake Oracle は、地震データをNautilus / TEE内で再検証し、Sui Moveで検証可能な署名付きDisasterEvent Payloadへ変換する層です。

## 主なワークフロー

1. Cloudflare CronがCloudflare Workerを起動する。
2. WorkerがUSGS recent earthquakes APIを取得する。
3. Workerが候補地震を状態管理し、必要時のみNautilus runnerを起動する。
4. Nautilus / TEEがUSGS詳細を再取得・再検証する。
5. Nautilus / TEEがBand、H3 cell、Merkle root、監査hash、BCS Payload、署名を生成する。
6. Relayerが署名付きPayloadをSui Moveへ投稿する。
7. Moveが署名、status、freshness、revision、source、rootを検証してDisasterEventを作成する。

## このワークフローの要点

- Workerは軽量Watcherであり、候補検出、状態管理、Nautilus起動だけを担当する。
- Nautilus / TEEは最終判定者として、外部sourceを再取得し、Band判定、H3生成、Payload生成、署名を行う。
- Relayerは単なる配送係であり、MoveはRelayerやWorkerを信頼しない。
- Moveは登録済みNautilus / TEE署名Payloadだけを検証し、`finalized` のDisasterEventだけをClaim接続対象にする。

## 目的

USGSなどの地震データをもとに、対象地域・揺れの強さ・監査用hash・対象H3 cell rootを確定し、Sui上のDisasterEvent作成へ接続します。

この文書では、MVPで実装判断に必要な責任分界、構成、データ要件、Move検証要件だけを定義します。

## MVP対象

- 対象災害は地震のみ。
- MagnitudeのみではDisasterEventをfinalizeしない。
- 最終Band判定はUSGS MMI / ShakeMap、または日本デモ用のJMA震度で行う。
- `finalized` のDisasterEventのみClaim接続可能にする。
- H3 resolutionは7固定。
- `affected_cells` はMVPでは半径方式で生成する。

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
| 候補検出 | Cloudflare WorkerがUSGS recent earthquakes APIを定期取得 |
| 最終検証 | Nautilus / TEEがUSGS詳細を再取得して実施 |
| Band判定 | USGS MMI優先、日本デモではJMA震度を補助 |
| Magnitude | 候補検出には使うがfinalize条件には使わない |
| Claim接続 | `finalized` のみ許可 |
| H3 | resolution 7固定 |
| affected_cells | MVPは半径方式、将来はShakeMap polygon方式へ拡張 |
| raw data | `raw_data_hash` は必須、`raw_data_uri` はMVPではoptional |
| TEE | Nautilus実行環境。Marlin OysterまたはAWS Nitro Enclavesを想定 |

## 2. 補足: 全体構成

```txt
Cloudflare Cron Trigger
  -> Cloudflare Worker: Sonari Earthquake Watcher
  -> USGS recent earthquakes API
  -> Cloudflare KV / D1 / Queue
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
- 過去60分の地震を重複スキャンする。
- `source_event_id` による冪等管理を行う。
- KVまたはD1にイベント状態を保存する。
- Cloudflare Queueを使う場合はNautilus起動ジョブを投入する。
- 候補地震を見つけたらAWS Nautilus runner起動APIを呼ぶ。
- `pending_mmi` の再チェック予定を管理する。
- 手動投入APIで `source_event_id` を受け付ける。
- Worker失敗、Nautilus起動失敗、再試行上限到達を通知対象にする。

### Cloudflare Workerがやらないこと

- DisasterEventをfinalizeしない。
- Band最終判定をしない。
- H3 cellを生成しない。
- Merkle rootを生成しない。
- BCS Payloadを生成しない。
- TEE署名をしない。
- SuiへDisasterEventを直接作成しない。

### Nautilus / TEEがやること

- Workerから受け取った `source_event_id` をもとにUSGS詳細を再取得する。
- 必要に応じてUSGS ShakeMap productまたはJMA震度データを取得・照合する。
- source freshness、source更新時刻、許可sourceを検証する。
- MMI / JMA震度からBand 1〜3を判定する。
- `pending_mmi` / `finalized` / `rejected` を決定する。
- H3 resolution 7で `affected_cells` を生成する。
- MVPではBand別半径方式で `affected_cells` を生成する。
- `affected_cells_root` を生成する。
- `raw_data_hash` と `source_set_hash` を生成する。
- Moveと同じ構造のBCS Payloadを生成する。
- Nautilus / TEE内の秘密鍵でPayloadに署名する。

### Relayerがやること

- Nautilus / TEEが生成した署名付きPayloadをSui Moveへ送信する。
- Payloadの内容を変更しない。
- 信頼対象ではないため、Move検証を通らないPayloadは無効になる。

### Sui Moveがやること

- Nautilus署名Payloadを検証する。
- `finalized` 以外をClaim接続可能なDisasterEventとして扱わない。
- 古いrevision、期限切れPayload、許可されていないsourceを拒否する。
- `affected_cells_root` と `affected_cells_uri` を保存し、Claim側のMerkle proof検証へ接続する。

## 4. 技術スタックと各プログラム

MVPでは、責任分界をそのままプログラム境界に対応させます。実装コードやpackage manifestはこの文書では追加せず、採用方針だけを定義します。

| 対象 | 採用技術 | 役割 |
| --- | --- | --- |
| `nautilus_disaster_oracle/watcher/` | Cloudflare Workers、TypeScript、Wrangler | Cron、USGS recent earthquakes API取得、KV / D1状態管理、Queue投入、AWS起動API呼び出し、手動投入API |
| `nautilus_disaster_oracle/tee/` | Rust、Nautilus、serde、reqwest、bcs、sha2、h3oまたはh3ron | USGS詳細再取得、Band判定、H3生成、Merkle root生成、監査hash生成、BCS Payload生成、TEE署名 |
| `nautilus_disaster_oracle/relayer/` | TypeScriptまたはRust、Sui SDK | 署名済みPayloadのSui投稿、投稿結果の記録、再試行 |
| `nautilus_disaster_oracle/shared/` | TypeScript | Oracle内部の共有型、定数、validator |
| `nautilus_disaster_oracle/fixtures/` | JSON | USGS / JMAの再現用サンプルデータ、TEE・Watcher・Relayerの共通テスト入力 |
| `contracts/` | Sui Move | 署名Payload検証、revision管理、DisasterEvent Object作成、Claim接続用root保存 |
| `dapp/` | React / Next.js、TypeScript、Sui dApp Kit | Dashboard、Claim、DisasterEvent表示、Wallet接続 |
| `packages/` | TypeScript | 全体共有のUI / configのみ。Oracle専用コードは置かない |
| `scripts/` | shellまたはTypeScript補助スクリプト | ローカル実行、TEEデプロイ、Enclave登録、Payload投稿 |
| storage / queue | Cloudflare KVまたはD1、Cloudflare Queues、optional R2 | 候補地震の状態管理、TEE起動ジョブ管理、必要に応じたwatcher snapshot保存 |
| TEE / runtime | Marlin Oyster第一候補、AWS Nitro Enclaves第二候補 | Nautilus実行環境、秘密鍵隔離、署名生成 |

## 5. DisasterEvent判定方針

DisasterEventのfinalize条件にはMagnitudeを使いません。Magnitudeは候補地震の検出にだけ使います。

| Sonari Band | USGS MMI | JMA震度 | Moveでの扱い |
| --- | --- | --- | --- |
| Band 0 | MMI VII未満 | 震度6弱未満 | finalized対象外 |
| Band 1 | MMI VII以上 | 震度6弱 | finalized対象 |
| Band 2 | MMI VIII以上 | 震度6強 | finalized対象 |
| Band 3 | MMI IX以上 | 震度7 | finalized対象 |

判定優先順位は、USGS MMI / ShakeMap、JMA震度、`pending_mmi` の順です。どちらの揺れ指標も取得できない場合、Nautilus / TEEはDisasterEventをfinalizeせず `pending_mmi` とします。

| Status | 意味 | Claim接続 |
| --- | --- | --- |
| `pending_mmi` | 候補地震は検出したが、揺れの強さが未確定 | 不可 |
| `finalized` | Band、対象H3 cell、監査hashが確定 | 可 |
| `rejected` | 古い、不完全、対象外、許可source外 | 不可 |

`event_uid` は同じ地震で固定し、更新は `event_revision` と `source_updated_at_ms` で表します。Move側は古いrevisionと同一revisionの再投稿を拒否します。

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
| `severity_band` | `finalized` では1〜3 |
| `status` | `pending_mmi` / `finalized` / `rejected` |
| `event_revision` | 同一eventの更新番号 |
| `occurred_at_ms` | 地震発生時刻 |
| `observed_at_ms` | Oracle観測時刻 |
| `source_updated_at_ms` | source側の更新時刻 |
| `primary_source` | 許可source名 |
| `source_set_hash` | source集合の監査hash |
| `raw_data_hash` | 元データの監査hash。Nautilus / TEE内で生成 |
| `raw_data_uri` | MVPではoptional |
| `affected_cells_root` | H3 cell集合のMerkle root。Nautilus / TEE内で生成 |
| `affected_cells_uri` | `finalized` では必須 |
| `geo_resolution` | 7 |
| `cells_generation_method` | MVPでは `radius_v1` |
| `freshness_deadline_ms` | Payload有効期限 |

`raw_data_hash`、`source_set_hash`、`affected_cells_root` はNautilus / TEE内で生成します。Workerが渡した値は信頼しません。

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
| affected_cells_root | 空でない32-byte rootであること |
| affected_cells_uri | finalizedでは空でないこと |

## 8. 見逃しリスク対策

Cloudflare Cronは失敗、遅延、API一時障害を前提に設計します。

- Cronは3〜5分ごとに再実行する。
- 各Cronで過去60分のUSGS recent earthquakesを重複スキャンする。
- `source_event_id` で冪等管理し、同じ候補を重複起動しない。
- 状態は `new` / `processing` / `pending_mmi` / `completed` / `failed` で管理する。
- `pending_mmi` は再チェック予定時刻を持つ。
- 過去24時間の定期バックフィルをShould要件にする。
- Worker失敗、Nautilus起動失敗、再試行上限到達は通知する。
- 手動投入APIで特定 `source_event_id` を再処理できるようにする。

## 9. インフラ方針

AWSは軽量Watcherではなく、Nautilus / TEE実行環境として扱います。

- 軽量WatcherはCloudflare Workers Cron Triggerで実装する。
- MVPではEC2 / Nitro Enclaveを常時稼働させない。
- Workerが候補地震を検出した時だけ、AWS Nautilus runner起動APIを呼ぶ。
- 処理完了後、または一定時間ジョブがなければEC2を停止する。
- Cloudflare KVまたはD1を状態管理に使う。
- Cloudflare QueuesはNautilus起動ジョブ化に使う。
- Marlin Oysterを第一候補、AWS Nitro Enclaves self-managedを第二候補にする。
- Could要件として、複数AWS Region / 複数Enclave fallbackを検討する。

## 10. MVP Must / Should / Could

### Must

- Cloudflare Workers Cron Trigger。
- USGS recent earthquakes API取得。
- 過去60分の重複スキャン。
- `source_event_id` 冪等管理。
- KVまたはD1による状態管理。
- WorkerからAWS Nautilus runner起動APIを呼ぶ。
- 手動投入API。
- Workerではfinalizeせず、Nautilus / TEEが再取得・再検証する責任分界。
- USGS詳細の再取得。
- MMI / `pending_mmi` 判定。
- Band 1〜3判定。
- H3 resolution 7の `affected_cells` 生成。
- MVPの `affected_cells` 半径方式。
- Merkle root生成。
- finalized event用 `affected_cells_uri`。
- `raw_data_hash` / `source_set_hash` 生成。
- BCS Payload生成。
- Nautilus / TEE署名。
- Moveでsignature / status / freshness / revision / source / rootを検証。

### Should

- `pending_mmi` 再チェックスケジューリング。
- Cloudflare Queuesによるジョブ化。
- 過去24時間の定期バックフィル。
- Worker失敗・Nautilus起動失敗通知。
- JMA震度fixture。
- `raw_data_uri`。
- Marlin OysterでのTEE化。

### Could

- permissionless trigger。
- USGS + JMAなど複数Watcher source。
- R2 watcher snapshot保存。
- Durable Objectsによるロック管理。
- 複数AWS Region / 複数Enclave fallback。
- 本物のJMA parser。
- ShakeMap polygon parser。
- Walrus保存。
- 複数Enclave quorum。

## 11. ディレクトリ構成

```txt
dapp/
  src/
    app/
      dashboard/
      claim/
      disaster_event/
    components/
    wallet/
  public/

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
        severity.rs
        geo.rs
        merkle.rs
        payload.rs
    allowed_endpoints.yaml
  watcher/
    package.json
    wrangler.toml
    src/
      index.ts
      usgs.ts
      state.ts
      trigger_tee.ts
      manual_submit.ts
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
  fixtures/
    usgs_mmi_vii.json
    usgs_pending_mmi.json
    jma_shindo_6_lower.json

contracts/
  Move.toml
  sources/
    sonari_oracle.move
    enclave_config.move

packages/
  ui/
  config/

docs/

scripts/
  local_process_data.sh
  deploy_oyster.sh
  register_enclave.sh
  post_disaster_event.sh
```

## まとめ

Sonari Earthquake Oracle v1は、Cloudflare Workerで候補地震を見つけ、Nautilus / TEEで地震データを再取得・再検証し、署名付きPayloadとしてSui Moveへ渡す最小構成にします。

Workerは起動・状態管理・見逃し対策に限定し、DisasterEventの最終判定、H3生成、Merkle root生成、BCS Payload生成、署名はNautilus / TEEが担います。MoveはWorkerを信頼せず、Nautilus署名Payloadのsignature / status / freshness / revision / source / rootを検証してDisasterEventを作成します。
