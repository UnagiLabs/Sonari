import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import {
    createRunnerServer,
    EnclaveCommandTeeAdapter,
    RustCliTeeAdapter,
    type TeeProcessAdapter,
} from "./index.js";

function main(): void {
    const token = requiredSecret("RUNNER_TOKEN", "RUNNER_TOKEN_FILE");
    const port = readPort(process.env.PORT ?? "8789");
    const tee = createTeeAdapter();
    const server = createRunnerServer({ token, tee });
    server.listen(port, "0.0.0.0", () => {
        process.stdout.write(`sonari earthquake runner listening on ${port}\n`);
    });
}

function createTeeAdapter(): TeeProcessAdapter {
    if (process.env.RUNNER_BACKEND === "aws") {
        const options: ConstructorParameters<typeof EnclaveCommandTeeAdapter>[0] = {
            command: requiredEnv("NITRO_ENCLAVE_PROCESS_COMMAND"),
            env: teeEnv(),
        };
        const args = process.env.NITRO_ENCLAVE_PROCESS_ARGS?.split(" ").filter(Boolean);
        if (args !== undefined) {
            options.args = args;
        }
        return new EnclaveCommandTeeAdapter(options);
    }

    return new RustCliTeeAdapter({
        cargoManifestPath:
            process.env.TEE_CARGO_MANIFEST_PATH ??
            "nautilus/verifiers/earthquake/tee/Cargo.toml",
        cwd: process.cwd(),
        env: teeEnv(),
    });
}

function teeEnv(): NodeJS.ProcessEnv {
    return { ...process.env };
}

function requiredEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (value === undefined || value.length === 0) {
        throw new Error(`${name} is required`);
    }
    return value;
}

function requiredSecret(valueName: string, fileName: string): string {
    const value = process.env[valueName]?.trim() ?? optionalSecret(fileName);
    if (value === undefined || value.length === 0) {
        throw new Error(`${valueName} or ${fileName} is required`);
    }
    return value;
}

function optionalSecret(fileName: string): string | undefined {
    const filePath = process.env[fileName];
    if (filePath === undefined || filePath.length === 0) {
        return undefined;
    }
    return readFileSync(filePath, "utf8").trim();
}

function readPort(value: string): number {
    const port = Number(value);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error("PORT must be an integer from 1 to 65535");
    }
    return port;
}

const mainPath = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (mainPath !== null && import.meta.url === mainPath) {
    main();
}
