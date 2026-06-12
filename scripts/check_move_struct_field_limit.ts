import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface MoveStructInfo {
    readonly filePath: string;
    readonly name: string;
    readonly fieldCount: number;
}

export interface MoveStructFieldLimitViolation extends MoveStructInfo {
    readonly limit: number;
}

const DEFAULT_FIELD_LIMIT = 32;
const DEFAULT_SOURCE_DIR = "contracts/sources";
const STRUCT_DECLARATION_PATTERN = /\b(?:public\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)\b/gu;

function stripLineComments(source: string): string {
    return source
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/u, ""))
        .join("\n");
}

function findStructBodyEnd(source: string, openingBraceIndex: number): number {
    let depth = 0;
    for (let index = openingBraceIndex; index < source.length; index += 1) {
        const character = source[index];
        if (character === "{") {
            depth += 1;
        } else if (character === "}") {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }

    throw new Error(`unterminated Move struct body at byte ${openingBraceIndex}`);
}

function countStructFields(body: string): number {
    return body
        .split(",")
        .map((field) => field.trim())
        .filter((field) => /^[A-Za-z_][A-Za-z0-9_]*\s*:/u.test(field)).length;
}

export function parseMoveStructs(filePath: string, source: string): MoveStructInfo[] {
    const withoutComments = stripLineComments(source);
    const structs: MoveStructInfo[] = [];

    for (const match of withoutComments.matchAll(STRUCT_DECLARATION_PATTERN)) {
        const name = match[1];
        if (name === undefined) {
            throw new Error(`missing Move struct name in ${filePath}`);
        }

        const declarationEndSearchStart = match.index + match[0].length;
        const declarationEndMatch = /[{;]/u.exec(withoutComments.slice(declarationEndSearchStart));
        if (declarationEndMatch === null) {
            throw new Error(`missing Move struct body or terminator for ${name} in ${filePath}`);
        }

        const declarationEndIndex = declarationEndSearchStart + declarationEndMatch.index;
        const declarationTerminator = withoutComments[declarationEndIndex];
        if (declarationTerminator === undefined) {
            throw new Error(`missing Move struct body or terminator for ${name} in ${filePath}`);
        }

        if (declarationTerminator === ";") {
            structs.push({ filePath, name, fieldCount: 0 });
            continue;
        }

        const bodyEndIndex = findStructBodyEnd(withoutComments, declarationEndIndex);
        const body = withoutComments.slice(declarationEndIndex + 1, bodyEndIndex);
        structs.push({ filePath, name, fieldCount: countStructFields(body) });
    }

    return structs;
}

export function checkMoveStructFieldLimit(
    structs: readonly MoveStructInfo[],
    limit = DEFAULT_FIELD_LIMIT,
): MoveStructFieldLimitViolation[] {
    return structs
        .filter((moveStruct) => moveStruct.fieldCount > limit)
        .map((moveStruct) => ({ ...moveStruct, limit }));
}

export function formatStructFieldLimitViolations(
    violations: readonly MoveStructFieldLimitViolation[],
): string {
    return violations
        .map(
            (violation) =>
                `${violation.filePath}: ${violation.name} has ${violation.fieldCount} fields; limit is ${violation.limit}`,
        )
        .join("\n");
}

async function readStructsFromSourceDir(sourceDir: string): Promise<MoveStructInfo[]> {
    const absoluteSourceDir = path.resolve(process.cwd(), sourceDir);
    const entries = await readdir(absoluteSourceDir, { withFileTypes: true });
    const moveFiles = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".move"))
        .map((entry) => path.join(absoluteSourceDir, entry.name))
        .sort();

    const structs: MoveStructInfo[] = [];
    for (const moveFile of moveFiles) {
        const source = await readFile(moveFile, "utf8");
        structs.push(...parseMoveStructs(path.relative(process.cwd(), moveFile), source));
    }

    return structs;
}

async function main(): Promise<void> {
    const sourceDir = process.argv[2] ?? DEFAULT_SOURCE_DIR;
    const structs = await readStructsFromSourceDir(sourceDir);
    const violations = checkMoveStructFieldLimit(structs);

    if (violations.length > 0) {
        console.error(formatStructFieldLimitViolations(violations));
        process.exitCode = 1;
        return;
    }

    console.log(
        `Checked ${structs.length} Move structs in ${sourceDir}; all have <= ${DEFAULT_FIELD_LIMIT} fields.`,
    );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    await main();
}
