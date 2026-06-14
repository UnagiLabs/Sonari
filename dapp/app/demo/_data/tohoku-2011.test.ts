import { describe, expect, it } from "vitest";
import enMessages from "../../../messages/en.json";
import jaMessages from "../../../messages/ja.json";
import { TOHOKU_2011_DEMO_EARTHQUAKE } from "./tohoku-2011";

// ---------------------------------------------------------------------------
// フィクスチャ実値との一致検証
// 出どころ:
//   nautilus/verifiers/earthquake/fixtures/usgs/great_tohoku_2011/input/usgs_detail.json
//   nautilus/verifiers/earthquake/fixtures/usgs/great_tohoku_2011/expected/unsigned_payload.json
//   nautilus/verifiers/earthquake/fixtures/usgs/great_tohoku_2011/expected/result.json
// ---------------------------------------------------------------------------

describe("TOHOKU_2011_DEMO_EARTHQUAKE", () => {
    it("title matches fixture", () => {
        expect(TOHOKU_2011_DEMO_EARTHQUAKE.title).toBe(
            "M 9.1 - 2011 Great Tohoku Earthquake, Japan",
        );
    });

    it("region matches fixture", () => {
        expect(TOHOKU_2011_DEMO_EARTHQUAKE.region).toBe(
            "2011 Great Tohoku Earthquake, Japan",
        );
    });

    it("occurredOn is 2011-03-11", () => {
        expect(TOHOKU_2011_DEMO_EARTHQUAKE.occurredOn).toBe("2011-03-11");
    });

    it("occurredAtMs matches fixture raw value", () => {
        expect(TOHOKU_2011_DEMO_EARTHQUAKE.occurredAtMs).toBe(1299822384120);
    });

    it("magnitude is 9.1", () => {
        expect(TOHOKU_2011_DEMO_EARTHQUAKE.magnitude).toBe(9.1);
    });

    it("mmi is 8.18", () => {
        expect(TOHOKU_2011_DEMO_EARTHQUAKE.mmi).toBe(8.18);
    });

    it("severityBand is 3", () => {
        expect(TOHOKU_2011_DEMO_EARTHQUAKE.severityBand).toBe(3);
    });

    it("affectedCellCount is 18429", () => {
        expect(TOHOKU_2011_DEMO_EARTHQUAKE.affectedCellCount).toBe(18429);
    });

    it("h3Resolution is 7", () => {
        expect(TOHOKU_2011_DEMO_EARTHQUAKE.h3Resolution).toBe(7);
    });

    it("epicenter latitude is 38.297", () => {
        expect(TOHOKU_2011_DEMO_EARTHQUAKE.epicenter.latitude).toBe(38.297);
    });

    it("epicenter longitude is 142.373", () => {
        expect(TOHOKU_2011_DEMO_EARTHQUAKE.epicenter.longitude).toBe(142.373);
    });

    it("epicenter depthKm is 29", () => {
        expect(TOHOKU_2011_DEMO_EARTHQUAKE.epicenter.depthKm).toBe(29);
    });

    it("usgsEventId matches fixture source_event_id", () => {
        expect(TOHOKU_2011_DEMO_EARTHQUAKE.usgsEventId).toBe(
            "official20110311054624120_30",
        );
    });
});

// ---------------------------------------------------------------------------
// i18n パリティ検証: en/ja の demo 名前空間の leaf キー集合が一致すること
// ---------------------------------------------------------------------------

/** オブジェクトのすべての leaf キーパスを "a.b.c" 形式で収集する。 */
function collectLeafPaths(obj: unknown, prefix = ""): string[] {
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
        return [prefix];
    }
    return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
        collectLeafPaths(v, prefix === "" ? k : `${prefix}.${k}`),
    );
}

describe("demo i18n parity (en / ja)", () => {
    it("en.demo and ja.demo have identical leaf key sets", () => {
        const enPaths = collectLeafPaths(enMessages.demo).sort();
        const jaPaths = collectLeafPaths(jaMessages.demo).sort();
        expect(enPaths).toEqual(jaPaths);
    });

    it("en.demo has the expected keys", () => {
        const enPaths = collectLeafPaths(enMessages.demo).sort();
        expect(enPaths).toContain("donate.status");
        expect(enPaths).toContain("donate.statusNote");
        expect(enPaths).toContain("donate.details.magnitude");
        expect(enPaths).toContain("donate.details.mmi");
        expect(enPaths).toContain("donate.details.region");
        expect(enPaths).toContain("donate.details.date");
        expect(enPaths).toContain("donate.details.affectedCells");
        expect(enPaths).toContain("donate.details.h3Resolution");
        expect(enPaths).toContain("donate.details.epicenter");
    });
});
