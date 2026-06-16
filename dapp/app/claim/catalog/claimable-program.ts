// ---------------------------------------------------------------------------
// ClaimableProgram: カテゴリ（disaster / student-fund / medical）を持つ共通モデル
//
// 本番キャンペーンとデモカタログを同じ形で一覧表示するための土台。
// 下流の STEP 3（変換アダプタ）と STEP 4（デモカタログ）がこの型を使う。
// ---------------------------------------------------------------------------

import { type CellBand, parseCellBand } from "./cell-band-rules";

// ---------------------------------------------------------------------------
// AmountSummary: 表示用の推定金額
// ---------------------------------------------------------------------------

/**
 * 災害など幅のある給付は "range"、学生支援・医療など固定額は "fixed"。
 * 金額はすべて USDC 建ての表示用デモ値。
 */
export type AmountSummary =
    | { readonly kind: "range"; readonly minUsdc: number; readonly maxUsdc: number }
    | { readonly kind: "fixed"; readonly usdc: number };

// ---------------------------------------------------------------------------
// CellSource: 地図セルの取得元
// ---------------------------------------------------------------------------

/**
 * 地図セルの参照先。2 系統を表す。
 * - "static-asset": デモ用静的 JSON ファイル（path を指定）
 * - "deferred": 本番用。後続 issue でワーカー取得をつなぐため、本 issue では実体を持たない
 */
export type CellSource =
    | { readonly kind: "static-asset"; readonly path: string }
    | { readonly kind: "deferred" };

export interface MapBounds {
    readonly north: number;
    readonly south: number;
    readonly east: number;
    readonly west: number;
}

export interface AffectedAreaArtifactSource {
    readonly kind: "tiled-affected-cells";
    readonly manifestPath: string;
}

// ---------------------------------------------------------------------------
// カテゴリ別型
// ---------------------------------------------------------------------------

/** 全カテゴリ共通フィールド。 */
interface ClaimableProgramBase {
    /** プログラム識別子。 */
    readonly id: string;
    /** 表示タイトル。 */
    readonly title: string;
    /** 対象範囲の説明（地域や対象者）。 */
    readonly scope: string;
    /** 表示用の推定金額。 */
    readonly amountSummary: AmountSummary;
    /**
     * 請求締切（10 進ミリ秒文字列）。
     * 既存 ClaimCampaignState.claimEndMs と同形式。
     */
    readonly deadlineMs: string;
    /** 詳細ページへのリンク。 */
    readonly detailHref: string;
}

/** 災害プログラム。地図メタを追加で持つ。 */
export interface DisasterClaimableProgram extends ClaimableProgramBase {
    readonly category: "disaster";
    /**
     * イベント識別子（"0x" 始まりの 32 バイト hex 文字列）。
     * 表示・受け渡し用。検証ロジックは持たない。
     */
    readonly eventUid: string;
    /** プログラム全体のバンド。STEP 1 の CellBand 型。 */
    readonly severityBand: CellBand;
    /** 被災セル数（表示用）。 */
    readonly affectedCellCount: number;
    /** 地図セルの取得元。 */
    readonly cellSource: CellSource;
    /** 表示用 affected-area artifact の取得元。 */
    readonly affectedAreaArtifact?: AffectedAreaArtifactSource;
    /**
     * セルルート（任意）。表示・受け渡し用のみ。
     * 検証しない。
     */
    readonly affectedCellsRoot?: string;
}

/** 学生支援基金プログラム。地図メタを持たない。 */
export interface StudentFundClaimableProgram extends ClaimableProgramBase {
    readonly category: "student-fund";
}

/** 医療・難病支援プログラム。地図メタを持たない。 */
export interface MedicalClaimableProgram extends ClaimableProgramBase {
    readonly category: "medical";
}

/**
 * カテゴリで判別する discriminated union。
 * `category: "disaster"` のときのみ地図メタフィールドを持つ。
 */
export type ClaimableProgram =
    | DisasterClaimableProgram
    | StudentFundClaimableProgram
    | MedicalClaimableProgram;

// ---------------------------------------------------------------------------
// 型ガード
// ---------------------------------------------------------------------------

/**
 * `p` が `DisasterClaimableProgram` かを判定する。
 * true のとき `p` を `DisasterClaimableProgram` に narrowing できる。
 */
export function isDisasterProgram(p: ClaimableProgram): p is DisasterClaimableProgram {
    return p.category === "disaster";
}

/**
 * プログラムが地図を持つかを返す。
 * 地図を持つのは災害カテゴリのみ。
 */
export function programHasMap(p: ClaimableProgram): boolean {
    return p.category === "disaster";
}

// ---------------------------------------------------------------------------
// 境界検証・パース
// ---------------------------------------------------------------------------

/**
 * `unknown` を受け取り、有効な `ClaimableProgram` であれば返す。
 * 不正カテゴリ・必須フィールド欠落・不正値はすべて `null` を返す（fail-closed）。
 * 外部入力（API レスポンス、デモカタログ JSON 等）の境界検証に使う。
 */
export function parseClaimableProgram(value: unknown): ClaimableProgram | null {
    if (!isRecord(value)) {
        return null;
    }

    const base = parseBase(value);
    if (base === null) {
        return null;
    }

    const { category } = base;

    if (category === "disaster") {
        return parseDisaster(value, base);
    }
    if (category === "student-fund") {
        return { ...base, category };
    }
    if (category === "medical") {
        return { ...base, category };
    }

    return null;
}

// ---------------------------------------------------------------------------
// 内部パーサー
// ---------------------------------------------------------------------------

interface ParsedBase {
    readonly id: string;
    readonly category: string;
    readonly title: string;
    readonly scope: string;
    readonly amountSummary: AmountSummary;
    readonly deadlineMs: string;
    readonly detailHref: string;
}

function parseBase(value: Record<string, unknown>): ParsedBase | null {
    const id = parseNonEmptyString(value["id"]);
    if (id === null) return null;

    const category = parseCategory(value["category"]);
    if (category === null) return null;

    const title = parseNonEmptyString(value["title"]);
    if (title === null) return null;

    const scope = parseNonEmptyString(value["scope"]);
    if (scope === null) return null;

    const amountSummary = parseAmountSummary(value["amountSummary"]);
    if (amountSummary === null) return null;

    const deadlineMs = parseDecimalMsString(value["deadlineMs"]);
    if (deadlineMs === null) return null;

    const detailHref = parseNonEmptyString(value["detailHref"]);
    if (detailHref === null) return null;

    return { id, category, title, scope, amountSummary, deadlineMs, detailHref };
}

function parseDisaster(
    value: Record<string, unknown>,
    base: ParsedBase,
): DisasterClaimableProgram | null {
    const eventUid = parseNonEmptyString(value["eventUid"]);
    if (eventUid === null) return null;

    const severityBand = parseCellBand(value["severityBand"]);
    if (severityBand === null) return null;

    const affectedCellCount = parseNonNegativeInteger(value["affectedCellCount"]);
    if (affectedCellCount === null) return null;

    const cellSource = parseCellSource(value["cellSource"]);
    if (cellSource === null) return null;

    const affectedAreaArtifact = parseAffectedAreaArtifactSource(value["affectedAreaArtifact"]);
    if (affectedAreaArtifact === undefined) return null;

    // affectedCellsRoot は任意
    const affectedCellsRoot =
        typeof value["affectedCellsRoot"] === "string" && value["affectedCellsRoot"].trim().length > 0
            ? value["affectedCellsRoot"]
            : undefined;

    const result: DisasterClaimableProgram = {
        id: base.id,
        category: "disaster",
        title: base.title,
        scope: base.scope,
        amountSummary: base.amountSummary,
        deadlineMs: base.deadlineMs,
        detailHref: base.detailHref,
        eventUid,
        severityBand,
        affectedCellCount,
        cellSource,
        ...(affectedAreaArtifact !== null ? { affectedAreaArtifact } : {}),
        ...(affectedCellsRoot !== undefined ? { affectedCellsRoot } : {}),
    };

    return result;
}

// ---------------------------------------------------------------------------
// フィールドパーサー
// ---------------------------------------------------------------------------

function parseCategory(value: unknown): string | null {
    if (
        value === "disaster" ||
        value === "student-fund" ||
        value === "medical"
    ) {
        return value;
    }
    return null;
}

function parseAmountSummary(value: unknown): AmountSummary | null {
    if (!isRecord(value)) return null;

    if (value["kind"] === "range") {
        const minUsdc = parseFiniteNumber(value["minUsdc"]);
        const maxUsdc = parseFiniteNumber(value["maxUsdc"]);
        if (minUsdc === null || maxUsdc === null) return null;
        return { kind: "range", minUsdc, maxUsdc };
    }

    if (value["kind"] === "fixed") {
        const usdc = parseFiniteNumber(value["usdc"]);
        if (usdc === null) return null;
        return { kind: "fixed", usdc };
    }

    return null;
}

function parseCellSource(value: unknown): CellSource | null {
    if (!isRecord(value)) return null;

    if (value["kind"] === "static-asset") {
        const path = parseNonEmptyString(value["path"]);
        if (path === null) return null;
        return { kind: "static-asset", path };
    }

    if (value["kind"] === "deferred") {
        return { kind: "deferred" };
    }

    return null;
}

function parseAffectedAreaArtifactSource(
    value: unknown,
): AffectedAreaArtifactSource | null | undefined {
    if (value === undefined || value === null) {
        return null;
    }
    if (!isRecord(value) || value["kind"] !== "tiled-affected-cells") {
        return undefined;
    }

    const manifestPath = parseNonEmptyString(value["manifestPath"]);
    if (manifestPath === null) return undefined;

    return {
        kind: "tiled-affected-cells",
        manifestPath,
    };
}

/**
 * 10 進ミリ秒文字列（非負整数の 10 進表記）を検証する。
 * 既存の parseU64String と同じルール。
 */
function parseDecimalMsString(value: unknown): string | null {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
        return String(value);
    }
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return /^(0|[1-9]\d*)$/u.test(trimmed) ? trimmed : null;
}

function parseNonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseFiniteNumber(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return value;
}

function parseNonNegativeInteger(value: unknown): number | null {
    if (typeof value !== "number") return null;
    if (!Number.isInteger(value) || value < 0) return null;
    return value;
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}
