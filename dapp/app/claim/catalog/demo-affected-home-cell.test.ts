import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAffectedCells } from "../affected-area/affected-cells";
import {
    DEMO_AFFECTED_HOME_CELL_BAND1,
    DEMO_AFFECTED_HOME_CELL_BAND3,
    DEMO_RESIDENCE_HOME_CELL,
} from "./demo-catalog";

// ---------------------------------------------------------------------------
// デモ居住セルが被災セット内にあることを静的に担保するテスト。
//
// 実アセット dapp/public/demo/tohoku-2011-affected-cells.json を node:fs で
// 読み込み、parseAffectedCells でパースした結果に DEMO_RESIDENCE_HOME_CELL（自宅・陸地）
// と DEMO_AFFECTED_HOME_CELL_BAND3 / _BAND1（バンド色の例示）が含まれ、期待バンドである
// ことを確認する。
//
// .tsx コンポーネントは import しない（node 環境で壊れやすいため）。
// ---------------------------------------------------------------------------

const affectedCellsPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../public/demo/tohoku-2011-affected-cells.json",
);

const rawJson: unknown = JSON.parse(readFileSync(affectedCellsPath, "utf8"));
const affectedCells = parseAffectedCells(rawJson);

describe("tohoku-2011-affected-cells.json 読み込み健全性", () => {
    it("セル数が正の値である", () => {
        expect(affectedCells.length).toBeGreaterThan(0);
    });
});

describe("DEMO_RESIDENCE_HOME_CELL（デモ会員証の自宅・陸地）が被災セットに含まれる", () => {
    const cell = affectedCells.find((c) => c.decimal === DEMO_RESIDENCE_HOME_CELL);

    it("アセットに存在する", () => {
        expect(cell).toBeDefined();
    });

    it("band が 2 である（仙台付近の陸地セル）", () => {
        expect(cell?.band).toBe(2);
    });
});

describe("DEMO_AFFECTED_HOME_CELL_BAND3 が被災セットに含まれる", () => {
    const cell = affectedCells.find((c) => c.decimal === DEMO_AFFECTED_HOME_CELL_BAND3);

    it("アセットに存在する", () => {
        expect(cell).toBeDefined();
    });

    it("band が 3 である", () => {
        expect(cell?.band).toBe(3);
    });
});

describe("DEMO_AFFECTED_HOME_CELL_BAND1 が被災セットに含まれる", () => {
    const cell = affectedCells.find((c) => c.decimal === DEMO_AFFECTED_HOME_CELL_BAND1);

    it("アセットに存在する", () => {
        expect(cell).toBeDefined();
    });

    it("band が 1 である", () => {
        expect(cell?.band).toBe(1);
    });
});
