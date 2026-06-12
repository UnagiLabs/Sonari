import { readFileSync } from "node:fs";
import {
    buildRelayerRequestPreview,
    createEd25519SuiSignerFromPrivateKey,
    dryRunRelayerSubmit,
    loadFixtureRelayerSubmitInput,
    submitRelayerPayload,
} from "./index.js";

type Command = "build-request" | "dry-run" | "submit";

interface CliOptions {
    command: Command;
    fixtureCase?: string;
    input?: string;
    grpcUrl?: string;
    network?: "mainnet" | "testnet" | "devnet";
    target?: string;
    registry?: string;
    verifierRegistry?: string;
    categoryRegistry?: string;
    categoryPool?: string;
    signer?: string;
    sender?: string;
}

async function main(argv: string[]): Promise<number> {
    const options = parseArgs(argv);
    if (options === undefined) {
        printUsage();
        return 1;
    }

    const input = loadInput(options);
    if (!input.ok) {
        printJson(input);
        return 1;
    }

    if (options.command === "build-request") {
        const result = buildRelayerRequestPreview(input.value, {
            target: options.target ?? "",
            registry: options.registry ?? "",
            verifierRegistry: options.verifierRegistry ?? "",
            categoryRegistry: options.categoryRegistry ?? "",
            categoryPool: options.categoryPool ?? "",
        });
        printJson(result);
        return result.ok ? 0 : 1;
    }

    if (options.command === "dry-run") {
        const result = await dryRunRelayerSubmit(input.value, {
            target: options.target ?? "",
            registry: options.registry ?? "",
            verifierRegistry: options.verifierRegistry ?? "",
            categoryRegistry: options.categoryRegistry ?? "",
            categoryPool: options.categoryPool ?? "",
            network: options.network ?? "testnet",
            grpcUrl: options.grpcUrl ?? "",
            senderAddress: options.sender ?? "",
        });
        printJson(result);
        return result.ok ? 0 : 1;
    }

    if (
        !options.grpcUrl ||
        !options.network ||
        !options.target ||
        !options.registry ||
        !options.verifierRegistry ||
        !options.categoryRegistry ||
        !options.categoryPool ||
        !options.signer
    ) {
        printJson({
            ok: false,
            error_code: "RELAYER_SUBMIT_FAILED",
            message:
                "submit requires --grpc-url, --target, --registry, --verifier-registry, --category-registry, --category-pool, and --signer",
        });
        return 1;
    }

    const signer = createEd25519SuiSignerFromPrivateKey(options.signer);
    const result = await submitRelayerPayload(input.value, {
        target: options.target,
        registry: options.registry,
        verifierRegistry: options.verifierRegistry,
        categoryRegistry: options.categoryRegistry,
        categoryPool: options.categoryPool,
        network: options.network,
        grpcUrl: options.grpcUrl,
        signer,
    });
    printJson(result);
    return result.ok ? 0 : 1;
}

function parseArgs(argv: string[]): CliOptions | undefined {
    const args = argv[0] === "--" ? argv.slice(1) : argv;
    const command = args[0];
    if (command !== "build-request" && command !== "dry-run" && command !== "submit") {
        return undefined;
    }

    const options: CliOptions = { command };
    for (let index = 1; index < args.length; index += 2) {
        const flag = args[index];
        const value = args[index + 1];
        if (value === undefined) {
            return undefined;
        }

        switch (flag) {
            case "--fixture-case":
                options.fixtureCase = value;
                break;
            case "--input":
                options.input = value;
                break;
            case "--grpc-url":
                options.grpcUrl = value;
                break;
            case "--network":
                if (value !== "mainnet" && value !== "testnet" && value !== "devnet") {
                    return undefined;
                }
                options.network = value;
                break;
            case "--target":
                options.target = value;
                break;
            case "--registry":
                options.registry = value;
                break;
            case "--verifier-registry":
                options.verifierRegistry = value;
                break;
            case "--category-registry":
                options.categoryRegistry = value;
                break;
            case "--category-pool":
                options.categoryPool = value;
                break;
            case "--signer":
                options.signer = value;
                break;
            case "--sender":
                options.sender = value;
                break;
            default:
                return undefined;
        }
    }

    return options;
}

function loadInput(
    options: CliOptions,
): { ok: true; value: unknown } | { ok: false; error: string } {
    if (options.fixtureCase !== undefined) {
        return { ok: true, value: loadFixtureRelayerSubmitInput(options.fixtureCase) };
    }

    if (options.input !== undefined) {
        return { ok: true, value: JSON.parse(readFileSync(options.input, "utf8")) };
    }

    return { ok: false, error: "Provide --fixture-case or --input" };
}

function printJson(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printUsage(): void {
    process.stderr.write(
        [
            "Usage:",
            "  pnpm relayer -- build-request --fixture-case usgs/finalized_minimal --target <target> --registry <registry> --verifier-registry <registry> --category-registry <registry> --category-pool <pool>",
            "  pnpm relayer -- dry-run --input <payload.json> --network <mainnet|testnet|devnet> --grpc-url <url> --target <target> --registry <registry> --verifier-registry <registry> --category-registry <registry> --category-pool <pool> --sender <address>",
            "  pnpm relayer -- submit --input <payload.json> --network <mainnet|testnet|devnet> --grpc-url <url> --target <target> --registry <registry> --verifier-registry <registry> --category-registry <registry> --category-pool <pool> --signer <sui-private-key>",
        ].join("\n"),
    );
}

main(process.argv.slice(2))
    .then((exitCode) => {
        process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
        printJson({
            ok: false,
            error_code: "RELAYER_SUBMIT_FAILED",
            message: error instanceof Error ? error.message : String(error),
        });
        process.exitCode = 1;
    });
