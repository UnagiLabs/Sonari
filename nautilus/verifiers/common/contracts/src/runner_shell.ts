interface RunnerBootstrapReadinessShellCommandInput {
    requiredEnvNames?: readonly string[] | undefined;
    preEnvCommands?: readonly string[] | undefined;
    postEnvCommands?: readonly string[] | undefined;
}

interface RunnerSsmShellCommandInput {
    resultBucket: string;
    resultS3Key: string;
    nitroEnclaveProcessCommand: string;
    teeInput?: unknown;
    teeInputS3Uri?: string | undefined;
    requiredEnvNames?: readonly string[] | undefined;
    preEnvCommands?: readonly string[] | undefined;
    postEnvCommands?: readonly string[] | undefined;
    tempResultPath: string;
}

export function buildRunnerBootstrapReadinessShellCommand(
    input: RunnerBootstrapReadinessShellCommandInput = {},
): string {
    return [
        "set -euo pipefail",
        "test -f /opt/sonari/bootstrap-complete",
        "test -s /opt/sonari/runner.env",
        "source /opt/sonari/runner.env",
        ...(input.preEnvCommands ?? []),
        ...(input.requiredEnvNames ?? []).map((name) => buildRequiredShellEnvCheck(name)),
        ...(input.postEnvCommands ?? []),
    ].join("\n");
}

export function buildRunnerSsmShellCommand(input: RunnerSsmShellCommandInput): string {
    const commandInvocation = parseNitroEnclaveProcessCommand(input.nitroEnclaveProcessCommand)
        .map(shellSingleQuote)
        .join(" ");
    const hasInlineInput = Object.hasOwn(input, "teeInput");
    if (hasInlineInput === (input.teeInputS3Uri !== undefined)) {
        throw new Error("exactly one of teeInput or teeInputS3Uri is required");
    }
    const teeInvocation =
        input.teeInputS3Uri === undefined
            ? `printf '%s' ${shellSingleQuote(JSON.stringify(input.teeInput))} | ${commandInvocation} > ${shellSingleQuote(input.tempResultPath)}`
            : `aws s3 cp ${shellSingleQuote(input.teeInputS3Uri)} - | ${commandInvocation} > ${shellSingleQuote(input.tempResultPath)}`;
    return [
        "set -euo pipefail",
        "source /opt/sonari/runner.env",
        ...(input.preEnvCommands ?? []),
        ...(input.requiredEnvNames ?? []).map((name) => buildRequiredShellEnvCheck(name)),
        ...(input.postEnvCommands ?? []),
        `RESULT_S3_KEY=${shellSingleQuote(input.resultS3Key)}`,
        `NITRO_ENCLAVE_PROCESS_COMMAND=${shellSingleQuote(input.nitroEnclaveProcessCommand)}`,
        "export NITRO_ENCLAVE_PROCESS_COMMAND",
        teeInvocation,
        `aws s3 cp ${shellSingleQuote(input.tempResultPath)} ${shellSingleQuote(`s3://${input.resultBucket}/${input.resultS3Key}`)}`,
    ].join("\n");
}

function buildRequiredShellEnvCheck(name: string, message = `${name} is required`): string {
    return `: "\${${name}:?${message}}"`;
}

function parseNitroEnclaveProcessCommand(command: string): string[] {
    const words: string[] = [];
    let current = "";
    let quote: "'" | '"' | undefined;
    let wordStarted = false;

    for (let index = 0; index < command.length; index += 1) {
        const char = command[index];
        if (char === undefined) {
            throw new Error("invalid NITRO_ENCLAVE_PROCESS_COMMAND");
        }
        if (quote === "'") {
            if (char === "'") {
                quote = undefined;
            } else {
                current += char;
            }
            continue;
        }
        if (quote === '"') {
            if (char === '"') {
                quote = undefined;
                continue;
            }
            if (char === "\\") {
                const next = command[index + 1];
                if (next === undefined) {
                    throw new Error("invalid NITRO_ENCLAVE_PROCESS_COMMAND: trailing escape");
                }
                current += next;
                index += 1;
                continue;
            }
            current += char;
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            wordStarted = true;
            continue;
        }
        if (char === "\\") {
            const next = command[index + 1];
            if (next === undefined) {
                throw new Error("invalid NITRO_ENCLAVE_PROCESS_COMMAND: trailing escape");
            }
            current += next;
            wordStarted = true;
            index += 1;
            continue;
        }
        if (/\s/.test(char)) {
            if (wordStarted) {
                words.push(current);
                current = "";
                wordStarted = false;
            }
            continue;
        }
        current += char;
        wordStarted = true;
    }

    if (quote !== undefined) {
        throw new Error("invalid NITRO_ENCLAVE_PROCESS_COMMAND: unterminated quote");
    }
    if (wordStarted) {
        words.push(current);
    }
    if (words.length === 0 || words[0]?.length === 0) {
        throw new Error("invalid NITRO_ENCLAVE_PROCESS_COMMAND: command is empty");
    }
    return words;
}

function shellSingleQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}
