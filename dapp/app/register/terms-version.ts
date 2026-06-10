// MembershipPass の terms version の単一情報源。
//
// この値から `computeIdentityStatementHash(termsVersion)` で導出した
// signed_statement_hash が membership 発行時に pass へ刻まれ、identity 検証では
// 同じ hash が World ID の signal_hash 束縛に使われる。発行側（membership）と
// 検証側（identity）で値がずれると identity 検証が不一致になるため、
// 両ステップは必ずこの定数を参照すること。
export const MEMBERSHIP_TERMS_VERSION = 1;
