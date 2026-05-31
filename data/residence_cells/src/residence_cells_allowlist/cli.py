from __future__ import annotations

import argparse
import json
import sys

from .core import (
    ResidenceAllowlistError,
    build_allowlist_artifact,
    proof_output,
    read_text_bytes,
    root_output,
    verify_local,
    write_pretty_json,
)


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    try:
        if args.command == "generate":
            source, source_bytes = read_text_bytes(args.source)
            artifact = build_allowlist_artifact(source, source_bytes, args.allowlist_version)
            write_pretty_json(args.output, artifact)
        elif args.command == "root":
            print(json.dumps(root_output(args.allowlist, args.source), indent=2))
        elif args.command == "proof":
            print(json.dumps(proof_output(args.allowlist, args.source, args.h3_index), indent=2))
        elif args.command == "verify-local":
            print(json.dumps(verify_local(args.manifest, args.allowlist, args.source), indent=2))
        else:
            parser.error("missing command")
    except (OSError, json.JSONDecodeError, ResidenceAllowlistError) as error:
        print(error, file=sys.stderr)
        return 1

    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="residence-allowlist",
        description="Generate and inspect local residence allowlist artifacts",
    )
    subcommands = parser.add_subparsers(dest="command", required=True)

    generate = subcommands.add_parser("generate")
    generate.add_argument("--source", required=True)
    generate.add_argument("--output", required=True)
    generate.add_argument("--allowlist-version", type=int, default=1)

    root = subcommands.add_parser("root")
    root.add_argument("--allowlist", required=True)
    root.add_argument("--source", required=True)

    proof = subcommands.add_parser("proof")
    proof.add_argument("--allowlist", required=True)
    proof.add_argument("--source", required=True)
    proof.add_argument("--h3-index", required=True)

    verify_local_parser = subcommands.add_parser("verify-local")
    verify_local_parser.add_argument("--manifest", required=True)
    verify_local_parser.add_argument("--allowlist", required=True)
    verify_local_parser.add_argument("--source", required=True)

    return parser


if __name__ == "__main__":
    raise SystemExit(main())
