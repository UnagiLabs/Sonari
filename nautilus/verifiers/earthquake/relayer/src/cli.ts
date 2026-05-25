import { readFileSync } from "node:fs";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
    buildRelayerRequestPreview,
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
    target?: string;
    registry?: string;
    verifierRegistry?: string;
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
        });
        printJson(result);
        return result.ok ? 0 : 1;
    }

    if (options.command === "dry-run") {
        const result = await dryRunRelayerSubmit(input.value, {
            target: options.target ?? "",
            registry: options.registry ?? "",
            verifierRegistry: options.verifierRegistry ?? "",
            grpcUrl: options.grpcUrl ?? "",
            senderAddress: options.sender ?? "",
        });
        printJson(result);
        return result.ok ? 0 : 1;
    }

    if (
        !options.grpcUrl ||
        !options.target ||
        !options.registry ||
        !options.verifierRegistry ||
        !options.signer
    ) {
        printJson({
            ok: false,
            error_code: "RELAYER_SUBMIT_FAILED",
            message:
                "submit requires --grpc-url, --target, --registry, --verifier-registry, and --signer",
        });
        return 1;
    }

    const signer = loadEd25519Signer(options.signer);
    const result = await submitRelayerPayload(input.value, {
        target: options.target,
        registry: options.registry,
        verifierRegistry: options.verifierRegistry,
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
            case "--target":
                options.target = value;
                break;
            case "--registry":
                options.registry = value;
                break;
            case "--verifier-registry":
                options.verifierRegistry = value;
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

function loadEd25519Signer(value: string): Ed25519Keypair {
    const decoded = decodeSuiPrivateKey(value);
    if (decoded.scheme !== "ED25519") {
        throw new Error("Only Ed25519 Sui private keys are supported for relayer submit");
    }

    return Ed25519Keypair.fromSecretKey(decoded.secretKey);
}

function printJson(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printUsage(): void {
    process.stderr.write(
        [
            "Usage:",
            "  pnpm relayer -- build-request --fixture-case usgs/finalized_minimal --target <target> --registry <registry> --verifier-registry <registry>",
            "  pnpm relayer -- dry-run --input <payload.json> --grpc-url <url> --target <target> --registry <registry> --verifier-registry <registry> --sender <address>",
            "  pnpm relayer -- submit --input <payload.json> --grpc-url <url> --target <target> --registry <registry> --verifier-registry <registry> --signer <sui-private-key>",
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
