# Membership Fixtures

`fixtures` は、membership verifier の contract と rejection rule を固定するためのテストデータを置く場所です。

本番 source や個人情報は置きません。fixture は deterministic な test / golden vector / documentation 用です。

## フォルダ

| フォルダ | 役割 |
| --- | --- |
| `identity/` | KYC / World ID identity result の最小 fixture |
| `residence/` | 将来の residence verifier fixture 用の予約領域 |
| `student/` | 将来の student verifier fixture 用の予約領域 |

## 扱う境界

Fixture は検証ロジックの入力や期待出力を固定するために使います。worker や relayer の都合で、fixture の意味を変えないでください。

新しい verifier result field、provider enum、BCS field order、署名対象 bytes を変える場合は、対応する fixture と golden test も一緒に更新します。
