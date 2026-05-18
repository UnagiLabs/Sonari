import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = join(import.meta.dirname, "..", "migrations");

function migration(name: string): string {
    return readFileSync(join(migrationsDir, name), "utf8");
}

function addedColumns(sql: string): string[] {
    return [...sql.matchAll(/ADD COLUMN\s+([a-z_]+)\s+/g)].map((match) => match[1] as string);
}

describe("watcher D1 migrations", () => {
    it("keeps 0002 scoped to the original relayer preview columns", () => {
        expect(addedColumns(migration("0002_add_relayer_preview_columns.sql"))).toEqual([
            "relayer_preview_status",
            "relayer_request_json",
            "relayer_error_code",
            "relayer_error_message",
            "relayer_preview_updated_at_ms",
        ]);
    });

    it("adds relayer mode columns in 0004 without duplicating 0002 columns", () => {
        expect(addedColumns(migration("0004_add_relayer_mode_columns.sql"))).toEqual([
            "relayer_mode",
            "relayer_status",
            "relayer_digest",
            "relayer_updated_at_ms",
            "relayer_submitted_at_ms",
        ]);
    });

    it("provides all current repository relayer columns after 0002 and 0004", () => {
        const columns = new Set([
            ...addedColumns(migration("0002_add_relayer_preview_columns.sql")),
            ...addedColumns(migration("0004_add_relayer_mode_columns.sql")),
        ]);

        expect(columns).toEqual(
            new Set([
                "relayer_preview_status",
                "relayer_request_json",
                "relayer_error_code",
                "relayer_error_message",
                "relayer_preview_updated_at_ms",
                "relayer_mode",
                "relayer_status",
                "relayer_digest",
                "relayer_updated_at_ms",
                "relayer_submitted_at_ms",
            ]),
        );
    });
});
