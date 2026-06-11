import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 薄い文字色トークンのコントラスト比を固定するテスト（issue #282）。
// globals.css から OKLCH 値を読み、WCAG の相対輝度に変換してコントラスト比を
// 計算する。--ink-muted / --ink-faint を背景クリーム色（--cream-100）に重ねた
// ときの比が AA 基準 4.5:1 以上であることを保証する。文字が読みづらくなる退行を
// 検知する。新規依存は足さず、変換式はこのテスト内に閉じて持つ。

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../globals.css"), "utf8");

const AA_MIN_RATIO = 4.5;

interface Oklch {
    readonly l: number;
    readonly c: number;
    readonly h: number;
}

/** `--name: oklch(L C H);` の L/C/H を取り出す。 */
function readOklchToken(name: string): Oklch {
    const re = new RegExp(`--${name}:\\s*oklch\\(\\s*([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s*\\)`);
    const m = css.match(re);
    if (m === null) {
        throw new Error(`token --${name} (oklch) not found in globals.css`);
    }
    return { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]) };
}

/** OKLCH -> linear sRGB（低彩度・gamut 内の UI 色のため clamp で十分）。 */
function oklchToLinearSrgb({ l: L, c: C, h: hDeg }: Oklch): [number, number, number] {
    const h = (hDeg * Math.PI) / 180;
    const a = C * Math.cos(h);
    const b = C * Math.sin(h);
    const l_ = L + 0.396_337_777_4 * a + 0.215_803_757_3 * b;
    const m_ = L - 0.105_561_345_8 * a - 0.063_854_172_8 * b;
    const s_ = L - 0.089_484_177_5 * a - 1.291_485_548_0 * b;
    const ll = l_ ** 3;
    const mm = m_ ** 3;
    const ss = s_ ** 3;
    const r = 4.076_741_662_1 * ll - 3.307_711_591_3 * mm + 0.230_969_929_2 * ss;
    const g = -1.268_438_004_6 * ll + 2.609_757_401_1 * mm - 0.341_319_396_5 * ss;
    const bl = -0.004_196_086_3 * ll - 0.703_418_614_7 * mm + 1.707_614_701_0 * ss;
    return [r, g, bl];
}

/** WCAG 相対輝度。 */
function relativeLuminance(color: Oklch): number {
    const clamp = (x: number): number => Math.max(0, Math.min(1, x));
    const [r, g, b] = oklchToLinearSrgb(color).map(clamp) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG コントラスト比。 */
function contrastRatio(a: Oklch, b: Oklch): number {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    const hi = Math.max(la, lb);
    const lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
}

describe("薄い文字色トークンの WCAG コントラスト", () => {
    // 主要テキストが乗る最も暗い背景はクリーム（--cream-100）。白（--surface）より
    // 比が低いため、ここを満たせば白背景でも満たす。
    const cream = readOklchToken("cream-100");

    it("--ink-muted は背景クリームに対して AA(4.5:1) 以上", () => {
        const ratio = contrastRatio(readOklchToken("ink-muted"), cream);
        expect(ratio).toBeGreaterThanOrEqual(AA_MIN_RATIO);
    });

    it("--ink-faint は背景クリームに対して AA(4.5:1) 以上", () => {
        const ratio = contrastRatio(readOklchToken("ink-faint"), cream);
        expect(ratio).toBeGreaterThanOrEqual(AA_MIN_RATIO);
    });

    it("明度階層 ink < ink-muted < ink-faint を保つ", () => {
        const ink = readOklchToken("ink");
        const muted = readOklchToken("ink-muted");
        const faint = readOklchToken("ink-faint");
        expect(ink.l).toBeLessThan(muted.l);
        expect(muted.l).toBeLessThan(faint.l);
    });
});
