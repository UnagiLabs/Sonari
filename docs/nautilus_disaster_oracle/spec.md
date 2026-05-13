# Sonari

Sonari / Nautilus Application Layer

地震データをNautilusで検証可能なオンチェーン証明に変換し、Sui上のDisasterEvent、支援金Claim、災害支払いへつなげるためのNautilus Disaster Oracle層 要件定義です。

## 概要

### 一言でいうと

**Sonari Earthquake Oracle** は、USGSなどの地震データを読み、「どの地域がどれくらい揺れたか」をTEE内で判定し、署名付きPayloadとしてSuiへ渡すアプリです。

### MVP方針

対象災害は**地震のみ**。世界基準は**USGS MMI / ShakeMap**、日本シナリオでは**JMA震度を同等Bandへ換算**します。

## 1. 今回の決定事項

**決定:** Sonari Disaster Oracle v1では、津波・台風・洪水は扱わず、地震だけに絞る。災害Event判定はMagnitudeではなく、揺れの強さを表すUSGS MMI / JMA震度を使う。

| 項目 | 内容 |
| --- | --- |
| アプリ名 | **Sonari** |
| MVP災害 | 地震のみ |
| 対象レイヤー | Disaster Oracle層。ユーザーEligibility Claim、資金Pool、支払い実行は別レイヤー |
| 世界基準 | USGS MMI / ShakeMap |
| 日本デモ | JMA震度をSuiRelief/Sonari内のBandへ換算 |
| Magnitudeのみ | DisasterEventをfinalizeしない。`pending_mmi` として待機またはManual Reviewへ |
| H3 resolution | MVPは7固定。将来はPoolごとに6〜8で設定可能 |
| affected_cells | MVPは半径方式。将来はShakeMap polygon方式へ拡張 |
| raw data | `raw_data_hash` は必須。`raw_data_uri` はMVPではoptional |
| Claim接続 | `finalized` eventでは、Claim側がMerkle proofを作れるように `affected_cells_uri` を必須にする |
| Flood Pool | 全体デモのDesignated Pool表示のみ。Nautilus Oracle v1の自動検知対象には含めない |
| TEE方針 | 第一候補 Marlin Oyster、第二候補 AWS Nitro Enclaves self-managed |
| Move検証 | 標準検証を採用。signature / intent / status / freshness / revision / source / root を検証 |

## 2. このアプリの責任範囲

この資料では、Nautilus Disaster Oracle層だけを扱います。資金Pool、ユーザーEligibility Claim、支払い、収益モデルは別レイヤーです。

### Sonari Earthquake Oracleがやること

- USGSなどの地震データを取得する
- 必要に応じてJMA震度データを補助入力として扱う
- 取得データを共通形式に正規化する
- 古いデータや不完全なデータを拒否・保留する
- USGS MMI / JMA震度からseverity bandを判定する
- 対象地域をH3 geo cellに変換する
- 対象H3 cellのMerkle rootを作る
- Moveで検証可能なBCS Payloadを生成する
- PayloadにNautilus Enclave内の秘密鍵で署名する

### Sonari Earthquake Oracleがやらないこと

- 保険料や支援金額の計算
- ReliefPoolの資金管理
- ユーザーへの支払い実行
- Eligibility Proof / ClaimReceiptの発行
- ユーザーが本当にその地域に住んでいるかの証明
- Appealの最終承認
- 法規制やKYC判断
- フロントエンド全体

**責任の切り分け:** SonariのNautilus層は「地震の揺れと対象地域を検証可能にする係」。Moveコントラクトは「その証明を検証してDisasterEvent Objectを作る係」です。

### Sonari全体との接続

| レイヤー | 主な出力 | 責任 |
| --- | --- | --- |
| Disaster Oracle | `DisasterOracleResponse` / `DisasterEvent` | 地震の発生、揺れの強さ、対象H3 cell rootを検証可能にする |
| Eligibility Claim | `EligibilityProof` / `ReliefReceipt` | 会員登録時期、地域滞在、地域変更クールダウン、重複申請リスクを評価する |
| Payment / Pool | Relief Cash transfer / Sponsor Impact update | PoolPolicy、流動性、支払い上限、スポンサー実績更新を扱う |

Sonari全体資料の「Nautilusがユーザー適格性を秘匿検証する」という表現は、将来のEligibility Claim層を含む全体像です。本資料のOracle v1は、その前段であるDisasterEvent作成に責務を限定します。

## 3. なぜMagnitudeではなくMMI / JMA震度か

### Magnitude

地震そのもののエネルギーの大きさです。M7.0などで表されます。

ただし、深い地震や海域の地震では、Magnitudeが大きくても地上の被害が小さいことがあります。

### Intensity / MMI / JMA震度

ある場所で実際にどれくらい揺れたかを表します。災害Event判定にはこちらが向いています。

Sonariでは「対象地域がどれくらい揺れたか」を見てClaim可能性を決めます。

**決定:** 災害Event finalizeの条件にはMagnitudeを使わない。Magnitudeは候補地震の検出に使い、最終判定はMMIまたはJMA震度で行う。

## 4. USGS MMIとJMA震度のBand定義

JMA震度とMMIは完全に同じ尺度ではありません。そのため、厳密な換算ではなく、Sonari内の支払いルールとして保守的なBand対応を定義します。

| Sonari Band | USGS MMI | JMA震度 | 意味 |
| --- | --- | --- | --- |
| Band 0 | MMI VI未満 | 震度5強未満 | DisasterEvent finalize対象外 |
| Band 1 | MMI VII以上 | 震度6弱 | 強い揺れ。少額支援ティア候補 |
| Band 2 | MMI VIII以上 | 震度6強 | 大きな被害の可能性。中額支援ティア候補 |
| Band 3 | MMI IX以上 | 震度7 | 深刻な被害の可能性。最大支援ティア候補 |

### 判定ロジック案

```js
function decideEarthquakeBand(input) {
  // 世界基準: USGS MMI / ShakeMapを優先
  if (input.usgs_mmi >= 9.0) return 3;
  if (input.usgs_mmi >= 8.0) return 2;
  if (input.usgs_mmi >= 7.0) return 1;

  // 日本デモ・日本ローカル補助: JMA震度をBandへ換算
  if (input.jma_shindo === "7") return 3;
  if (input.jma_shindo === "6_upper") return 2;
  if (input.jma_shindo === "6_lower") return 1;

  return 0;
}
```

**優先順位:** 1. USGS MMI / ShakeMap、2. JMA震度、3. どちらもなければDisasterEventをfinalizeせず `pending_mmi` にする。

## 5. MMIがない場合の扱い

USGSの地震データに、常にMMIが入っているとは限りません。小さい地震、発生直後、海域・遠隔地、ShakeMap未生成のケースでは、Magnitudeや震源情報だけが先に出る場合があります。

### やらないこと

- MagnitudeだけでBandを決めない
- M7以上だから即支払い、のような判定をしない
- MMIが空のままDisasterEventをfinalizeしない

### やること

- Magnitudeは候補検出に使う
- MMI / ShakeMapが出るまで再取得する
- 一定時間出ない場合は `pending_mmi`
- 必要ならAppeal / Manual Reviewへ回す

```txt
if (!usgs_mmi && !jma_shindo) {
  status = "pending_mmi";
  auto_trigger = false;
}
```

### イベントライフサイクル

地震データは発生直後に更新されるため、同じ `event_uid` に対して状態遷移とrevisionを持たせます。`pending_mmi` はClaim接続対象ではなく、MMI / ShakeMapまたはJMA震度が取得できた時点で `finalized` revisionを作ります。

| Status | 意味 | Moveでの扱い |
| --- | --- | --- |
| `pending_mmi` | 候補地震は検出したが、揺れの強さが未確定 | DisasterEventは作ってもClaim接続不可、またはMVPでは作成しない |
| `finalized` | Band、対象H3 cell、監査hashが確定 | DisasterEvent作成とClaim接続を許可 |
| `rejected` | 古い、不完全、対象外、許可source外 | DisasterEvent作成不可 |

**revision方針:** `event_uid` は同じ地震で固定し、`event_revision` と `source_updated_at_ms` で更新を表す。Move側は同一 `event_uid` の古いrevisionを再利用できないようにする。

## 6. H3セルとは何か

H3は、地球全体を小さな六角形のマス目に分ける仕組みです。住所や市区町村ではなく、「地球上のこのマス」というIDで地域を表します。

### H3を使う理由

- 世界中を同じ仕組みで扱える
- 国や自治体の境界に依存しない
- ユーザーの登録地域と災害地域を同じIDで比較できる
- オンチェーンで扱いやすい

### Claim対象地域判定のイメージ

```txt
user_geo_cell = "8a2a1072b59ffff"

affected_cells = [
  "8a2a1072b59ffff",
  "8a2a1072b597fff"
]

user_geo_cell ∈ affected_cells
→ Claim OK
```

### H3 resolution

| Resolution | ざっくりした粒度 | 用途イメージ |
| --- | --- | --- |
| 6 | やや広い地域 | 台風・広域災害向き |
| **7** | 近所・小地域 | **地震MVPの推奨** |
| 8 | かなり細かい地域 | 洪水・津波など局所災害向き |

**決定:** MVPではH3 resolution 7で固定する。将来はPoolごとに6〜8を選べるようにする。

## 7. affected_cells生成：半径方式とShakeMap方式

`affected_cells` は、Claim対象になるH3セル一覧です。つまり「どの地域のユーザーがClaimできるか」を表すリストです。

### MVP：半径方式

震源地を中心に、Bandごとの半径内に入るH3セルを対象にします。

```txt
Band 1: 50km以内
Band 2: 100km以内
Band 3: 150km以内
```

- 実装が簡単
- USGSの緯度経度だけで動く
- デモしやすい

### 将来：ShakeMap polygon方式

USGS ShakeMapの「MMI VII以上の地域」など、実際の揺れ分布に近い形を使います。

- 実際の被害分布に近い
- 地盤や震源方向の違いを反映しやすい
- ただしpolygon parser実装が重い

**決定:** MVPは半径方式で実装する。ただしデータモデルは、将来ShakeMap polygonへ置き換えられる形にしておく。

**注意:** 半径方式はデモ実装を優先する近似です。USGS ShakeMap polygonが利用できる場合は、実際の揺れ分布に近いShakeMap方式を優先する設計へ移行します。

## 8. raw data hash と URIの違い

raw dataは、USGSなどから取得した元データです。Sonariでは、元データそのものをオンチェーンに載せず、hashやURIを使って監査できるようにします。

### raw_data_hash

元データの指紋です。同じデータからは同じhashができます。

- オンチェーンが軽い
- 改ざん検知ができる
- 必須項目にする

### raw_data_uri

元データの保存場所です。Walrus、S3、GitHub rawなどを使えます。

- あとから人間が確認しやすい
- 監査・デモに強い
- MVPではoptionalにする

```txt
raw_data_hash: 必須
raw_data_uri: optional。空文字OK

affected_cells_root: 必須
affected_cells_uri: finalized eventでは必須。pending / rejectedでは空文字OK
```

**Claim接続上の理由:** Claim側はユーザーのH3 cellが `affected_cells_root` に含まれることをMerkle proofで示す必要があります。そのため、`finalized` eventではproof生成に必要な `affected_cells` 一覧へ到達できるURIを必須にします。

## 9. 全体フロー

1. **USGS地震データを取得**  
   event_idまたは直近地震検索で、地震の緯度・経度・Magnitude・MMI・更新時刻を取得します。
2. **データを正規化**  
   APIの形式を、Sonari内の共通データ形式に変換します。
3. **鮮度チェック**  
   古い地震データでDisasterEventが作られないように、更新時刻と有効期限を確認します。
4. **MMI / JMA震度でBand判定**  
   Magnitudeではなく、揺れの強さからBand 1〜3を決めます。
5. **H3 affected_cellsを生成**  
   MVPでは震源からの半径方式で対象H3セルを作ります。
6. **Merkle rootを生成**  
   対象H3セル一覧をMerkle tree化し、rootだけをPayloadに入れます。
7. **Payloadを署名**  
   BCS形式のPayloadを作り、Nautilus Enclave内の秘密鍵で署名します。
8. **Suiへ投稿**  
   Relayerが署名付きPayloadをMoveコントラクトへ渡します。Relayerは信用しなくてよい設計です。
9. **Moveで標準検証**  
   署名、intent、期限、重複、source、rootを確認し、DisasterEvent Objectを作ります。

## 10. 入力と出力

### 入力：Sonari Nautilusに渡すリクエスト

```json
{
  "payload": {
    "request_type": "DETECT_BY_EVENT_ID",
    "hazard_type": "EARTHQUAKE",
    "primary_source": "USGS",
    "source_event_id": "us7000abcd",
    "geo_resolution": 7
  }
}
```

### 出力：Suiへ渡す署名付きPayload

```json
{
  "response": {
    "intent": 1001,
    "oracle_version": 1,
    "event_uid": "0x...",
    "hazard_type": 1,
    "severity_band": 2,
    "status": "finalized",
    "event_revision": 1,
    "occurred_at_ms": 1760000000000,
    "observed_at_ms": 1760000060000,
    "source_updated_at_ms": 1760000060000,
    "primary_source": "USGS",
    "source_set_hash": "0x...",
    "raw_data_hash": "0x...",
    "raw_data_uri": "https://... or walrus://...",
    "affected_cells_root": "0x...",
    "affected_cells_uri": "https://... or walrus://...",
    "geo_resolution": 7,
    "cells_generation_method": "radius_v1",
    "freshness_deadline_ms": 1760001860000
  },
  "signature": "0x..."
}
```

**statusの例:** `finalized` はDisasterEvent作成とClaim接続が可能、`pending_mmi` はMMI不足でClaim接続不可。

## 11. 機能要件

| ID | 要件 | 内容 | MVP優先度 |
| --- | --- | --- | --- |
| FR-1 | 地震イベント取得 | USGSからsource_event_idまたは検索条件を使って地震データを取得する。 | Must |
| FR-2 | USGS MMI取得 | USGS Summary / Detail / ShakeMapからMMIを取得する。なければpending_mmi。 | Must |
| FR-3 | JMA震度補助 | 日本デモではJMA震度をBandへ換算できるようにする。MVPではfixture/mockでも可。 | Should |
| FR-4 | データ正規化 | API形式をNormalizedEarthquakeEventに変換する。 | Must |
| FR-5 | 鮮度チェック | 古いデータを拒否する。地震は30分以内を初期値にする。 | Must |
| FR-6 | Band判定 | MMI VII/VIII/IX+、JMA震度6弱/6強/7からBand 1/2/3を決める。 | Must |
| FR-7 | H3 affected_cells生成 | H3 resolution 7で対象セルを作る。MVPでは半径方式。 | Must |
| FR-8 | Merkle root生成 | 対象H3セル一覧からMerkle rootを作る。 | Must |
| FR-9 | raw_data_hash生成 | 取得した元データをcanonical JSON化してhash化する。 | Must |
| FR-10 | URI保存 | raw_data_uriを任意でPayloadに入れられるようにする。affected_cells_uriはfinalized eventでは必須。 | Must |
| FR-11 | 署名付きPayload生成 | Moveと同じ構造をBCSでシリアライズし、Enclave秘密鍵で署名する。 | Must |
| FR-12 | event_uid生成 | hazard_type、source、source_event_id、occurred_atから決定的IDを作る。 | Must |
| FR-13 | 状態遷移 | pending_mmi / finalized / rejectedを明確に分け、finalizedだけをClaim接続対象にする。 | Must |
| FR-14 | revision管理 | 同じevent_uidの更新をevent_revisionとsource_updated_at_msで表現する。 | Must |
| FR-15 | Claim proof素材 | finalized eventではaffected_cells_uriを必須にし、Claim側がMerkle proofを生成できるようにする。 | Must |
| FR-16 | 監査hash正規化 | raw_data_hash / source_set_hashはcanonical JSONまたはBCSで決定的に生成する。 | Must |

## 12. データモデル

### NormalizedEarthquakeEvent

```ts
type NormalizedEarthquakeEvent = {
  source: "USGS" | "JMA";
  source_event_id: string;
  hazard_type: "EARTHQUAKE";
  occurred_at_ms: number;
  observed_at_ms: number;
  latitude_e7?: number;
  longitude_e7?: number;
  depth_m?: number;
  magnitude_x10?: number;
  mmi_x10?: number;
  jma_shindo_code?: number;
  raw_data_hash: string;
  raw_data_uri?: string;
};
```

Moveとの整合性を保つため、浮動小数点は整数に変換します。例：M7.3 → 73、MMI 7.2 → 72、緯度35.1234567 → 351234567。

### DisasterOracleResponse

```ts
type DisasterOracleResponse = {
  intent: number;
  oracle_version: number;
  event_uid: string;
  hazard_type: number;        // EARTHQUAKE = 1
  severity_band: number;      // 0, 1, 2, 3
  status: string;             // finalized / pending_mmi / rejected
  event_revision: number;
  occurred_at_ms: number;
  observed_at_ms: number;
  source_updated_at_ms: number;
  primary_source: string;
  source_set_hash: string;
  raw_data_hash: string;
  raw_data_uri: string;
  affected_cells_root: string;
  affected_cells_uri: string;
  geo_resolution: number;
  cells_generation_method: string; // radius_v1 / shakemap_polygon_v1
  freshness_deadline_ms: number;
};
```

**hash方針:** MVPでは、取得した元データをcanonical JSON化して `raw_data_hash` を作ります。`source_set_hash` は、source名、source_event_id、source_updated_at_ms、raw_data_hash、oracle_versionを決定的順序でまとめてhash化します。

## 13. 本番TEEインフラ方針

本番TEEまで持っていく方針。ハッカソンでは速さと確実性のバランスが重要です。

### 第一候補：Marlin Oyster

- Docker imageベースでTEE化しやすい
- Sui / Nautilus文脈と相性が良い
- AWS Nitroを直接触るより早い可能性が高い
- ハッカソンでは最優先で試す

### 第二候補：AWS Nitro Enclaves

- 公式で確実
- Nautilusの標準構成に近い
- EC2代が主なコスト
- ただし設定・運用は重め

**決定:** 実装戦略：ローカル署名版でPayload仕様を固める → Marlin OysterでTEE化 → 詰まったらAWS Nitro Enclavesへ切り替える。

## 14. Move側の標準検証

SonariのPayloadをMoveがそのまま信じてはいけません。Move側では、最低限以下を検証します。

| 検証項目 | なぜ必要か | MVP |
| --- | --- | --- |
| signature | 登録済みNautilus Enclaveが署名したPayloadか確認する。 | 必須 |
| intent | 別用途の署名を使い回されないようにする。 | 必須 |
| oracle_version | 許可された判定ロジックのversionか確認する。 | 必須 |
| status | pending_mmi / rejectedをClaim接続可能なDisasterEventとして扱わない。 | 必須 |
| freshness | 古いPayloadで災害Eventを作られないようにする。 | 必須 |
| revision | 同じevent_uidの古いrevisionや同一revisionの再投稿を拒否する。 | 必須 |
| hazard_type | MVPは地震のみなので、EARTHQUAKE以外を拒否する。 | 必須 |
| severity_band | Band 1〜3だけをfinalized DisasterEvent対象にする。 | 必須 |
| primary_source | USGSなど許可されたsourceか確認する。 | 必須 |
| source_set_hash | 監査用source集合のhashが空でないことを確認する。 | 必須 |
| raw_data_hash | 監査可能性のため、空でない32-byte hashを必須にする。 | 必須 |
| affected_cells_root | Claim対象地域のrootが空でないことを確認する。 | 必須 |
| affected_cells_uri | finalized eventではClaim proof生成に必要なURIが空でないことを確認する。 | 必須 |

```move
public entry fun create_disaster_event_from_sonari(
    enclave: &Enclave,
    signature: vector<u8>,
    response: DisasterOracleResponse,
    clock: &Clock,
    registry: &mut EventRegistry,
    ctx: &mut TxContext
) {
    assert!(verify_enclave_signature(enclave, signature, response), E_BAD_SIGNATURE);
    assert!(response.intent == SONARI_EARTHQUAKE_ORACLE_INTENT, E_BAD_INTENT);
    assert!(is_allowed_oracle_version(response.oracle_version), E_BAD_VERSION);
    assert!(response.status == STATUS_FINALIZED, E_BAD_STATUS);
    assert!(clock::timestamp_ms(clock) <= response.freshness_deadline_ms, E_STALE);
    assert!(registry::is_new_revision(registry, response.event_uid, response.event_revision), E_OLD_REVISION);
    assert!(response.hazard_type == HAZARD_EARTHQUAKE, E_BAD_HAZARD);
    assert!(response.severity_band >= 1 && response.severity_band <= 3, E_BAD_SEVERITY);
    assert!(is_allowed_source(response.primary_source), E_BAD_SOURCE);
    assert!(vector::length(&response.source_set_hash) == 32, E_BAD_SOURCE_HASH);
    assert!(vector::length(&response.raw_data_hash) == 32, E_BAD_RAW_HASH);
    assert!(vector::length(&response.affected_cells_root) == 32, E_BAD_ROOT);
    assert!(!is_empty_string(&response.affected_cells_uri), E_EMPTY_CELLS_URI);

    registry::mark_revision(registry, response.event_uid, response.event_revision);
    create_disaster_event_object(response, ctx);
}
```

## 15. 非機能要件

| ID | 要件 | 内容 |
| --- | --- | --- |
| NFR-1 | 検証可能性 | EnclaveのPCR、公開鍵、oracle_versionをSui上で確認できるようにする。 |
| NFR-2 | 改ざん耐性 | 秘密鍵はEnclaveの外に出さない。RelayerがPayloadを改ざんしたら署名検証に失敗する。 |
| NFR-3 | 鮮度 | 古い地震情報でDisasterEventが作られないように、freshness_deadline_msを必須にする。 |
| NFR-4 | 監査性 | raw_data_hash、source_set_hash、affected_cells_root、event_uidを保存し、あとから検証できるようにする。 |
| NFR-5 | 拡張性 | 地震MVPから、将来は津波・台風・洪水に拡張できる構造にする。 |
| NFR-6 | 可用性 | 将来は複数Enclaveを登録し、1台停止しても動く構成にする。 |

## 16. 技術スタック案

| 項目 | 内容 |
| --- | --- |
| 言語 | Rust |
| TEE | Marlin Oyster / AWS Nitro Enclaves |
| Nautilus | MystenLabs Nautilus template |
| HTTP server | Nautilus template / Axum系 |
| 外部API client | reqwest |
| Serialization | serde, serde_json, bcs |
| Hash | sha2 / SHA-256 |
| Geo cell | h3o または h3ron |
| Merkle tree | rs_merkle またはcustom implementation |
| Error handling | anyhow / thiserror |
| Logging | tracing |
| Testing | cargo test, wiremock / mockito, fixture JSON |
| Sui連携 | Sui Move, Nautilus Move package, Sui CLI |

## 17. ディレクトリ構成案

```txt
sonari-nautilus/
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

    tests/
      fixtures/
        usgs_mmi_vii.json
        usgs_pending_mmi.json
        jma_shindo_6_lower.json

  allowed_endpoints.yaml

  move/
    Move.toml
    sources/
      sonari_oracle.move
      enclave_config.move

  scripts/
    local_process_data.sh
    deploy_oyster.sh
    register_enclave.sh
    post_disaster_event.sh
```

## 18. allowed_endpoints.yaml案

```yaml
allowed_endpoints:
  - host: earthquake.usgs.gov
    port: 443
    protocol: https

  - host: www.data.jma.go.jp
    port: 443
    protocol: https

  - host: www.jma.go.jp
    port: 443
    protocol: https
```

## 19. ハッカソンMVPの実装範囲

### Must

- USGS地震データ取得
- MMI / pending_mmi判定
- Band 1〜3判定
- H3 resolution 7 affected_cells生成
- Merkle root生成
- finalized event用affected_cells_uri生成
- source_set_hash生成
- BCS Payload生成
- Nautilus Enclave署名
- Moveで標準検証

### Should

- JMA震度fixture
- raw_data_uri
- Marlin OysterでTEE化

### Could

- 本物のJMA parser
- ShakeMap polygon parser
- Walrus保存
- AWS Nitro fallback
- 複数Enclave quorum

Sonari全体デモではFlood PoolをDesignated Poolの将来拡張例として表示してよい。ただし、このNautilus Oracle v1の実装範囲は地震のみであり、Flood Poolの自動災害検知・自動Event作成は含めない。

## 20. 今後一緒に決めたい論点

1. **USGS MMI取得はSummaryだけで足りるか、Detail / ShakeMap productまで読むか。**
2. **JMA震度fixtureをどの形式で持つか。**
3. **MMIがない場合、何分まで再取得し、その後pendingにするか。**
4. **Bandごとの半径を50/100/150kmでよいか。**
5. **raw_data_uriをMVPでS3/GitHubにするか、Walrusまで入れるか。**
6. **Marlin Oysterで詰まった場合、AWS Nitro Enclavesへ切り替える期限をどこに置くか。**

## 21. まとめ

### Sonari Earthquake Oracle v1の目的

USGS MMIを世界基準とし、日本シナリオではJMA震度を同等Bandへ換算して、地震データをSui上で検証可能なDisasterEvent Objectへ変換すること。

### ハッカソンで狙う最小構成

USGS Earthquake API → Nautilus Rust app → MMI/JMA Band判定 → H3 affected_cells_root → 署名付きPayload → Move標準検証 → DisasterEvent Object作成。

### このレイヤーの本質

災害検知の結果を、管理者の手入力ではなく、検証可能なNautilus OracleとしてSuiに届けること。Sonariは、現実世界の地震データをSuiの災害支払いレールへ接続する入口になる。

Sonari Nautilus Earthquake Oracle Requirements / Draft for discussion
