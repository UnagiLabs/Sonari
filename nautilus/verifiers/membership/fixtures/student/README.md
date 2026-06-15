# Student Fixtures

`student` は、将来の student eligibility verifier fixture を置く予約領域です。

Student verifier は、membership に紐づく学生 eligibility を検証するための verifier として検討しています。現在の MVP では未実装です。

## 将来ここに置くもの

- 学生 eligibility が verified になる最小 success fixture。
- 有効期限切れ、issuer mismatch、domain mismatch などの reject fixture。
- raw credential を含まない expected result。
- Rust / TypeScript / Move をまたぐ payload golden vector。

## 置かないもの

- 実在する学生証、学校アカウント、email、document などの個人情報。
- KYC / World ID identity verification result。
- 地震 verifier の source artifact。

実装前に source policy、issuer trust model、payload field order を明示してから fixture を追加します。

---

**Parent docs**: [../../../../../docs/verifiers/identity.md](../../../../../docs/verifiers/identity.md) — component overview & full spec.
**親資料**: 同上（上位コンポーネントの概要・完全仕様）。
