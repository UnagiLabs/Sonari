#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/register-verifier-configs.sh \
    --package-id <PACKAGE_ID> \
    --admin-cap-id <ADMIN_CAP_ID> \
    --verifier-registry-id <VERIFIER_REGISTRY_ID> \
    --earthquake-pcr0 <PCR0> \
    --earthquake-pcr1 <PCR1> \
    --earthquake-pcr2 <PCR2> \
    --identity-pcr0 <PCR0> \
    --identity-pcr1 <PCR1> \
    --identity-pcr2 <PCR2> \
    --census-pcr0 <PCR0> \
    --census-pcr1 <PCR1> \
    --census-pcr2 <PCR2>

Required environment fallback (if flags are omitted):
  EARTHQUAKE_EIF_PCR0/1/2
  MEMBERSHIP_IDENTITY_EIF_PCR0/1/2
  CENSUS_EIF_PCR0/1/2

Optional:
  --sui-config <path>        (default: .local/sonari-dev/sui_wallets/admin/sui_config.yaml)
  --sui-env <env>            (default: testnet)
  --sender <address>         (optional explicit transaction sender)
  --gas-budget <amount>      (default: 100000000)
  --skip-identity            (skip identity config only)
  --skip-census              (skip census config only)
  --help

Exit status: 0 on success, non-zero on failure.
USAGE
}

normalize_hex_48() {
  local value="${1#0x}"
  local name="$2"
  if [[ -z "$value" ]]; then
    echo "[$name] is empty" >&2
    exit 1
  fi
  if [[ ! "$value" =~ ^[0-9a-fA-F]{96}$ ]]; then
    echo "[$name] must be 48-byte SHA-384 hex (96 hex chars), got: $value" >&2
    exit 1
  fi
  printf '%s' "${value,,}"
}

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "required command not found: $cmd" >&2
    exit 1
  fi
}

is_already_registered_error() {
  local text="$1"
  [[ "$text" == *"EVerifierConfigAlreadyRegistered"* ]] ||
    [[ "$text" == *"error code: 9"* ]] ||
    [[ "$text" == *"Abort code: 9"* ]] ||
    [[ "$text" == *"with code 9"* ]]
}

is_checkpoint_timeout_error() {
  local text="$1"
  [[ "$text" == *"CheckpointTimeout"* ]]
}

confirm_on_chain_pcrs() {
  local family_name="$1"
  local family_id="$2"
  local pcr0="$3"
  local pcr1="$4"
  local pcr2="$5"
  local registry_json
  local registry_status
  local parser_output
  local parser_status

  set +e
  registry_json=$(
    sui client \
      --client.config "$SUI_CLIENT_CONFIG" \
      --client.env "$SUI_CLIENT_ENV" \
      object "$VERIFIER_REGISTRY_ID" \
      --json \
      2>&1
  )
  registry_status=$?
  set -e
  if [[ "$registry_status" -ne 0 ]]; then
    echo "unable to read verifier registry after CheckpointTimeout" >&2
    return 1
  fi

  set +e
  parser_output=$(
    REGISTRY_JSON="$registry_json" \
    FAMILY_NAME="$family_name" \
    FAMILY_ID="$family_id" \
    EXPECTED_PCR0="$pcr0" \
    EXPECTED_PCR1="$pcr1" \
    EXPECTED_PCR2="$pcr2" \
    node <<'NODE' 2>&1
const registryJson = process.env.REGISTRY_JSON ?? "null";
const familyName = process.env.FAMILY_NAME ?? "unknown";
const familyId = Number(process.env.FAMILY_ID);
const expected = {
  pcr0: process.env.EXPECTED_PCR0 ?? "",
  pcr1: process.env.EXPECTED_PCR1 ?? "",
  pcr2: process.env.EXPECTED_PCR2 ?? "",
};

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function bytesToHex(value) {
  if (Array.isArray(value)) {
    if (value.length !== 48) {
      fail("PCR byte array must be 48 bytes");
    }
    return value
      .map((byte) => {
        const num = Number(byte);
        if (!Number.isInteger(num) || num < 0 || num > 255) {
          fail("PCR byte out of range");
        }
        return num.toString(16).padStart(2, "0");
      })
      .join("");
  }
  if (typeof value === "string") {
    const hex = value.startsWith("0x") ? value.slice(2) : value;
    if (/^[0-9a-fA-F]{96}$/.test(hex)) {
      return hex.toLowerCase();
    }
    const bytes = Buffer.from(value, "base64");
    if (bytes.length !== 48) {
      fail("PCR base64 field must decode to 48 bytes");
    }
    return bytes.toString("hex");
  }
  fail("PCR field is not a byte array or base64 string");
}

let root;
try {
  root = JSON.parse(registryJson);
} catch {
  fail(`unable to confirm ${familyName} config after CheckpointTimeout: invalid registry JSON`);
}

const configs = new Map();
function walk(node) {
  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item);
    }
    return;
  }
  if (node === null || typeof node !== "object") {
    return;
  }
  const fields = node.fields && typeof node.fields === "object" ? node.fields : node;
  if (
    fields &&
    "verifier_family" in fields &&
    "pcr0" in fields &&
    "pcr1" in fields &&
    "pcr2" in fields
  ) {
    configs.set(Number(fields.verifier_family), {
      pcr0: bytesToHex(fields.pcr0),
      pcr1: bytesToHex(fields.pcr1),
      pcr2: bytesToHex(fields.pcr2),
    });
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      walk(value);
    }
  }
}
walk(root);

const onChain = configs.get(familyId);
if (onChain === undefined) {
  fail(`unable to confirm ${familyName} config after CheckpointTimeout: family ${familyId} not found`);
}
for (const pcr of ["pcr0", "pcr1", "pcr2"]) {
  const want = expected[pcr].toLowerCase();
  if (!/^[0-9a-f]{96}$/.test(want)) {
    fail(`${familyName} expected ${pcr} is not a valid PCR`);
  }
  if (onChain[pcr] !== want) {
    fail(`${familyName} ${pcr} mismatch`);
  }
}
NODE
  )
  parser_status=$?
  set -e
  if [[ "$parser_status" -ne 0 ]]; then
    echo "$parser_output" >&2
    return 1
  fi
  return 0
}

run_sui_tx() {
  local function_name="$1"
  local pcr0="$2"
  local pcr1="$3"
  local pcr2="$4"
  local sender_args=()

  if [[ -n "$SUI_SENDER" ]]; then
    sender_args=(--sender "$SUI_SENDER")
  fi

  LAST_TX_OUTPUT=""
  set +e
  LAST_TX_OUTPUT=$(
    sui client \
      --client.config "$SUI_CLIENT_CONFIG" \
      --client.env "$SUI_CLIENT_ENV" \
      call \
      --package "$PACKAGE_ID" \
      --module admin \
      --function "$function_name" \
      --args "$ADMIN_CAP_ID" "$VERIFIER_REGISTRY_ID" "0x$pcr0" "0x$pcr1" "0x$pcr2" \
      "${sender_args[@]}" \
      --gas-budget "$GAS_BUDGET" \
      --json \
      2>&1
  )
  LAST_TX_STATUS=$?
  set -e
}

register_family() {
  local family_name="$1"
  local family_id="$2"
  local create_fn="$3"
  local update_fn="$4"
  local pcr0="$5"
  local pcr1="$6"
  local pcr2="$7"

  echo "---"
  echo "Registering ${family_name} config"

  run_sui_tx "$create_fn" "$pcr0" "$pcr1" "$pcr2"
  if [[ "$LAST_TX_STATUS" -eq 0 ]]; then
    echo "$LAST_TX_OUTPUT"
    echo "- create: OK"
    return 0
  fi
  if is_checkpoint_timeout_error "$LAST_TX_OUTPUT"; then
    if confirm_on_chain_pcrs "$family_name" "$family_id" "$pcr0" "$pcr1" "$pcr2"; then
      echo "- create: CheckpointTimeout recovered by on-chain PCR read-back"
      return 0
    fi
  fi

  if is_already_registered_error "$LAST_TX_OUTPUT"; then
    echo "- create: already exists, try update"
    run_sui_tx "$update_fn" "$pcr0" "$pcr1" "$pcr2"
    if [[ "$LAST_TX_STATUS" -eq 0 ]]; then
      echo "$LAST_TX_OUTPUT"
      echo "- update: OK"
      return 0
    fi
    if is_checkpoint_timeout_error "$LAST_TX_OUTPUT"; then
      if confirm_on_chain_pcrs "$family_name" "$family_id" "$pcr0" "$pcr1" "$pcr2"; then
        echo "- update: CheckpointTimeout recovered by on-chain PCR read-back"
        return 0
      fi
    fi
  fi

  echo "- failed: unable to register ${family_name} config" >&2
  echo "$LAST_TX_OUTPUT" >&2
  return 1
}

SUI_BIN="sui"
SUI_CLIENT_CONFIG="${SUI_CLIENT_CONFIG:-.local/sonari-dev/sui_wallets/admin/sui_config.yaml}"
SUI_CLIENT_ENV="${SUI_CLIENT_ENV:-testnet}"
SUI_SENDER="${SUI_SENDER:-}"
GAS_BUDGET="${GAS_BUDGET:-100000000}"
PACKAGE_ID=""
ADMIN_CAP_ID=""
VERIFIER_REGISTRY_ID=""
EARTHQUAKE_PCR0="${EARTHQUAKE_EIF_PCR0:-}"
EARTHQUAKE_PCR1="${EARTHQUAKE_EIF_PCR1:-}"
EARTHQUAKE_PCR2="${EARTHQUAKE_EIF_PCR2:-}"
IDENTITY_PCR0="${MEMBERSHIP_IDENTITY_EIF_PCR0:-}"
IDENTITY_PCR1="${MEMBERSHIP_IDENTITY_EIF_PCR1:-}"
IDENTITY_PCR2="${MEMBERSHIP_IDENTITY_EIF_PCR2:-}"
CENSUS_PCR0="${CENSUS_EIF_PCR0:-}"
CENSUS_PCR1="${CENSUS_EIF_PCR1:-}"
CENSUS_PCR2="${CENSUS_EIF_PCR2:-}"
SKIP_IDENTITY=0
SKIP_CENSUS=0

if [[ $# -eq 0 ]]; then
  usage
  exit 1
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --package-id)
      PACKAGE_ID="$2"
      shift 2
      ;;
    --admin-cap-id)
      ADMIN_CAP_ID="$2"
      shift 2
      ;;
    --verifier-registry-id)
      VERIFIER_REGISTRY_ID="$2"
      shift 2
      ;;
    --earthquake-pcr0)
      EARTHQUAKE_PCR0="$2"
      shift 2
      ;;
    --earthquake-pcr1)
      EARTHQUAKE_PCR1="$2"
      shift 2
      ;;
    --earthquake-pcr2)
      EARTHQUAKE_PCR2="$2"
      shift 2
      ;;
    --identity-pcr0)
      IDENTITY_PCR0="$2"
      shift 2
      ;;
    --identity-pcr1)
      IDENTITY_PCR1="$2"
      shift 2
      ;;
    --identity-pcr2)
      IDENTITY_PCR2="$2"
      shift 2
      ;;
    --census-pcr0)
      CENSUS_PCR0="$2"
      shift 2
      ;;
    --census-pcr1)
      CENSUS_PCR1="$2"
      shift 2
      ;;
    --census-pcr2)
      CENSUS_PCR2="$2"
      shift 2
      ;;
    --sui-config)
      SUI_CLIENT_CONFIG="$2"
      shift 2
      ;;
    --sui-env)
      SUI_CLIENT_ENV="$2"
      shift 2
      ;;
    --sender)
      SUI_SENDER="$2"
      shift 2
      ;;
    --gas-budget)
      GAS_BUDGET="$2"
      shift 2
      ;;
    --skip-identity)
      SKIP_IDENTITY=1
      shift
      ;;
    --skip-census)
      SKIP_CENSUS=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    *)
      echo "unknown arg: $1" >&2
      usage
      exit 1
      ;;
  esac
done

require_command "$SUI_BIN"
require_command node

if [[ -z "$PACKAGE_ID" ]]; then
  echo "--package-id is required" >&2
  exit 1
fi
if [[ -z "$ADMIN_CAP_ID" ]]; then
  echo "--admin-cap-id is required" >&2
  exit 1
fi
if [[ -z "$VERIFIER_REGISTRY_ID" ]]; then
  echo "--verifier-registry-id is required" >&2
  exit 1
fi

EARTHQUAKE_PCR0="$(normalize_hex_48 "$EARTHQUAKE_PCR0" "EARTHQUAKE_EIF_PCR0")"
EARTHQUAKE_PCR1="$(normalize_hex_48 "$EARTHQUAKE_PCR1" "EARTHQUAKE_EIF_PCR1")"
EARTHQUAKE_PCR2="$(normalize_hex_48 "$EARTHQUAKE_PCR2" "EARTHQUAKE_EIF_PCR2")"

if [[ "$SKIP_IDENTITY" -ne 1 ]]; then
  IDENTITY_PCR0="$(normalize_hex_48 "$IDENTITY_PCR0" "MEMBERSHIP_IDENTITY_EIF_PCR0")"
  IDENTITY_PCR1="$(normalize_hex_48 "$IDENTITY_PCR1" "MEMBERSHIP_IDENTITY_EIF_PCR1")"
  IDENTITY_PCR2="$(normalize_hex_48 "$IDENTITY_PCR2" "MEMBERSHIP_IDENTITY_EIF_PCR2")"
fi
if [[ "$SKIP_CENSUS" -ne 1 ]]; then
  CENSUS_PCR0="$(normalize_hex_48 "$CENSUS_PCR0" "CENSUS_EIF_PCR0")"
  CENSUS_PCR1="$(normalize_hex_48 "$CENSUS_PCR1" "CENSUS_EIF_PCR1")"
  CENSUS_PCR2="$(normalize_hex_48 "$CENSUS_PCR2" "CENSUS_EIF_PCR2")"
fi

if [[ "$SUI_CLIENT_ENV" != "testnet" && "$SUI_CLIENT_ENV" != "devnet" && "$SUI_CLIENT_ENV" != "mainnet" ]]; then
  echo "--sui-env should be testnet, devnet, or mainnet" >&2
  exit 1
fi
if [[ -n "$SUI_SENDER" && ! "$SUI_SENDER" =~ ^0x[0-9a-fA-F]+$ ]]; then
  echo "--sender must be a Sui address" >&2
  exit 1
fi

if [[ ! "$GAS_BUDGET" =~ ^[0-9]+$ ]]; then
  echo "--gas-budget must be an integer" >&2
  exit 1
fi

echo "package:           $PACKAGE_ID"
echo "admin cap:          $ADMIN_CAP_ID"
echo "verifier registry:  $VERIFIER_REGISTRY_ID"
echo "sui config:        $SUI_CLIENT_CONFIG"
echo "sui env:           $SUI_CLIENT_ENV"
if [[ -n "$SUI_SENDER" ]]; then
  echo "sender:            $SUI_SENDER"
fi
echo "gas budget:        $GAS_BUDGET"
if [[ "$SKIP_IDENTITY" -eq 1 ]]; then
  echo "identity:          skipped"
fi
if [[ "$SKIP_CENSUS" -eq 1 ]]; then
  echo "census:            skipped"
fi

echo "start register verifier configs"

LAST_TX_STATUS=0
LAST_TX_OUTPUT=""

register_family "earthquake" \
  3 \
  "create_earthquake_verifier_config" \
  "update_earthquake_verifier_config_pcrs" \
  "$EARTHQUAKE_PCR0" "$EARTHQUAKE_PCR1" "$EARTHQUAKE_PCR2"

if [[ "$SKIP_IDENTITY" -ne 1 ]]; then
  register_family "membership identity" \
    4 \
    "create_identity_verifier_config" \
    "update_identity_verifier_config_pcrs" \
    "$IDENTITY_PCR0" "$IDENTITY_PCR1" "$IDENTITY_PCR2"
fi

if [[ "$SKIP_CENSUS" -ne 1 ]]; then
  register_family "census" \
    5 \
    "create_census_verifier_config" \
    "update_census_verifier_config_pcrs" \
    "$CENSUS_PCR0" "$CENSUS_PCR1" "$CENSUS_PCR2"
fi

echo "all requested verifier configs registered"
