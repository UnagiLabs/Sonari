# 居住セル保存設計

## 概要

登録ウィザードで選択した H3 解像度 7 セルをどこに・どの形式で保存するかの設計を記録する。

## 保存先の設計決定

居住セルの**正式な保存先はオンチェーン**である。

Membership SBT を発行するとき、`register_member` Move 関数の `homeCell: u64` パラメータとしてセル ID がブロックチェーンに書き込まれる。この処理は登録ウィザードの membership ステップで実行される。

```
register_member(
    pause_state,
    membership_registry,
    allowed_residence_cell_registry,
    home_cell: u64,   ← H3 セル ID（10進 u64）
    residence_proof,
    terms_version,
    signed_statement_hash,
)
```

Membership SBT を持つウォレットは、オンチェーンに記録されたセルで資格確認（被災時の申請可否判定）を受ける。

## residence ステップの「保存」とは何か

residence ステップの「次へ」ボタンを押した時点で行われる「保存」は、次の 2 つを指す。

1. ウィザード状態の `residenceSaved` フラグを `true` にセットする
2. そのフラグを sessionStorage（`sonari.register.wizard.v1`）に書き込む

これにより、ページを再読み込みしても「residence ステップを完了した」という状態が復元され、ユーザーは membership ステップから再開できる。

実際のオンチェーン記録は membership ステップの SBT 発行時に行われる。

## 保存するデータ

| 項目 | 保存するもの | 保存しないもの |
|------|------------|--------------|
| セル ID | H3 解像度 7 の 10 進文字列（`selectedCellDecimal`） | 住所・GPS 座標・検索テキスト |
| フラグ | `residenceSaved: boolean` | ウォレットアドレス・World ID 応答 |

プライバシー境界として、住所・GPS 履歴・検索文字列は保存しない。Sonari が記録するのは H3 セル ID のみである。

## sessionStorage の形式と互換方針

- キー: `sonari.register.wizard.v1`
- バージョン: `1`（変更なし）
- `residenceSaved` フィールドの扱い:
  - フィールドが**存在する場合**: 値が `boolean` であれば使用、それ以外は fail-closed で初期状態に落とす
  - フィールドが**存在しない場合（既存セッション）**: `false` として読む（fail-soft）
- 既存セッションは `residenceSaved: false` として復元されるため、residence ステップから再開が必要になる。他のフィールド（セル選択・承諾状態など）は保持される。

## バックエンド API を設けなかった理由

居住セルのオンチェーン保存は Membership SBT 発行と同時に行われるため、別途バックエンドに保存する必要がない。

- オンチェーンデータは単一の正として機能し、verifier Lambda もオンチェーンの SBT を参照する
- バックエンドに中間保存を設けると、オンチェーン状態との二重管理が生じる
- sessionStorage は進行中セッションの状態管理のみを担い、永続データストアではない

将来的にセル変更・履歴管理などが必要になった場合は、この設計を見直す。

## 関連ファイル

| ファイル | 役割 |
|--------|------|
| `dapp/app/register/wizard/wizard-steps.ts` | `WizardState.residenceSaved` の定義・`canProceed` 条件 |
| `dapp/app/register/wizard/wizard-storage.ts` | sessionStorage への永続化（serialize / deserialize） |
| `dapp/app/register/wizard/residence-save.ts` | 保存ロジックの pure module（検証・フラグ設定） |
| `dapp/app/register/wizard/register-wizard.tsx` | UI 配線（`handleResidenceNext`） |
| `dapp/app/register/wizard/steps/residence-step.tsx` | エラー表示 UI |
| `contracts/sources/accessor.move` | `register_member` entry function（`homeCell` パラメータ） |
