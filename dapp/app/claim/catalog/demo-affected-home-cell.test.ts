import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAffectedCells } from "../affected-area/affected-cells";
import {
    DEMO_AFFECTED_HOME_CELL_BAND1,
    DEMO_AFFECTED_HOME_CELL_BAND3,
} from "./demo-catalog";

// ---------------------------------------------------------------------------
// デモ居住セルが被災セット内にあることを静的に担保するテスト。
//
// 実アセット dapp/public/demo/tohoku-2011-affected-cells.json を node:fs で
// 読み込み、parseAffectedCells でパースした結果に DEMO_AFFECTED_HOME_CELL_BAND3
// と DEMO_AFFECTED_HOME_CELL_BAND1 が含まれ、期待バンドであることを確認する。
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
