import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { checkMoveStructFieldLimit, parseMoveStructs } from "./check_move_struct_field_limit.js";

function structWithFieldCount(name: string, count: number): string {
    const fields = Array.from({ length: count }, (_, index) => {
        const fieldNumber = String(index + 1).padStart(2, "0");
        return `    field_${fieldNumber}: u64,`;
    }).join("\n");

    return `module contracts::fixture;\n\npublic struct ${name} has store {\n${fields}\n}\n`;
}

describe("Move struct field limit check", () => {
    it("allows a struct with exactly 32 fields", () => {
        const structs = parseMoveStructs("fixture.move", structWithFieldCount("MaxFields", 32));

        expect(structs).toEqual([
            {
                filePath: "fixture.move",
                name: "MaxFields",
                fieldCount: 32,
            },
        ]);
        expect(checkMoveStructFieldLimit(structs, 32)).toEqual([]);
    });

    it("rejects a struct with 33 fields", () => {
        const structs = parseMoveStructs("fixture.move", structWithFieldCount("TooManyFields", 33));

        expect(checkMoveStructFieldLimit(structs, 32)).toEqual([
            {
                filePath: "fixture.move",
                name: "TooManyFields",
                fieldCount: 33,
                limit: 32,
            },
        ]);
    });

    it("keeps contracts source structs within the Sui protocol field limit", async () => {
        const campaignPath = path.join(process.cwd(), "contracts/sources/campaign.move");
        const campaignSource = await readFile(campaignPath, "utf8");
        const structs = parseMoveStructs("contracts/sources/campaign.move", campaignSource);

        expect(checkMoveStructFieldLimit(structs, 32)).toEqual([]);
        expect(structs).toEqual(
            expect.arrayContaining([
                {
                    filePath: "contracts/sources/campaign.move",
                    name: "Campaign",
                    fieldCount: 26,
                },
                {
                    filePath: "contracts/sources/campaign.move",
                    name: "CampaignTerms",
                    fieldCount: 12,
                },
            ]),
        );
    });

    it("runs before Move build and tests in the check:move script", async () => {
        const packageJsonPath = path.join(process.cwd(), "package.json");
        const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
            scripts?: Record<string, string>;
        };

        expect(packageJson.scripts?.["check:move"]).toBe(
            "tsx scripts/check_move_struct_field_limit.ts && sui move build -p contracts --force --lint --warnings-are-errors && sui move test -p contracts",
        );
    });
});
