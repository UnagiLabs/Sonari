# USGS Earthquake Fixtures

`usgs` は、地震 verifier が USGS detail GeoJSON と ShakeMap grid を処理した時の入力と期待出力を固定する fixture set です。

テストはネットワークへ出ません。各 case の `input/` に保存した source bytes だけを読み、`expected/` の result、hash、Merkle root、BCS、signature と照合します。

## case の読み方

| case | 意味 |
| --- | --- |
| `finalized_minimal` | 最小の正常系。2 点の ShakeMap grid から affected cells を作る |
| `great_tohoku_2011` | 東日本大震災の USGS 実データを使う finalized case |
| `noto_peninsula_2024` | 能登半島地震の USGS 実データを使う finalized case |
| `pending_source_no_shakemap` | ShakeMap product がまだ存在しないため再試行対象になる case |
| `pending_mmi_empty_grid` | grid はあるが MMI point がなく、MMI 待ちになる case |
| `rejected_cancelled_shakemap` | ShakeMap が cancelled のため reject する case |
| `rejected_no_affected_cells` | grid はあるが claimable affected cells がない case |

## 各 case の構成

```text
<case>/
  README.md
  input/      USGS detail JSON と ShakeMap grid XML などの入力 source
  expected/   verifier が返すべき result と golden artifact
```

`input/` と `expected/` はデータ置き場です。case の意図は各 case 直下の `README.md` に書きます。

## 更新時の注意

`finalized` case の expected artifact は contract-facing な golden vector です。hash、Merkle root、BCS bytes、signature が変わる場合は、変更理由を明示し、Rust / Python の fixture 検証を一緒に更新してください。

```bash
python3 nautilus/verifiers/earthquake/fixtures/verify_fixtures.py
cargo test --manifest-path nautilus/verifiers/earthquake/tee/Cargo.toml
```
