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
    --identity-pcr2 <PCR2>

Required environment fallback (if flags are omitted):
  EARTHQUAKE_EIF_PCR0/1/2
  MEMBERSHIP_IDENTITY_EIF_PCR0/1/2

Optional:
  --sui-config <path>        (default: .local/sonari-dev/sui_wallets/admin/sui_config.yaml)
  --sui-env <env>            (default: testnet)
  --gas-budget <amount>      (default: 100000000)
  --skip-identity            (skip identity config only)
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

run_sui_tx() {
  local function_name="$1"
  local pcr0="$2"
  local pcr1="$3"
  local pcr2="$4"

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
      --gas-budget "$GAS_BUDGET" \
      --json \
      2>&1
  )
  LAST_TX_STATUS=$?
  set -e
}

register_family() {
  local family_name="$1"
  local create_fn="$2"
  local update_fn="$3"
  local pcr0="$4"
  local pcr1="$5"
  local pcr2="$6"

  echo "---"
  echo "Registering ${family_name} config"

  run_sui_tx "$create_fn" "$pcr0" "$pcr1" "$pcr2"
  if [[ "$LAST_TX_STATUS" -eq 0 ]]; then
    echo "$LAST_TX_OUTPUT"
    echo "- create: OK"
    return 0
  fi

  if is_already_registered_error "$LAST_TX_OUTPUT"; then
    echo "- create: already exists, try update"
    run_sui_tx "$update_fn" "$pcr0" "$pcr1" "$pcr2"
    if [[ "$LAST_TX_STATUS" -eq 0 ]]; then
      echo "$LAST_TX_OUTPUT"
      echo "- update: OK"
      return 0
    fi
  fi

  echo "- failed: unable to register ${family_name} config" >&2
  echo "$LAST_TX_OUTPUT" >&2
  return 1
}

SUI_BIN="sui"
SUI_CLIENT_CONFIG="${SUI_CLIENT_CONFIG:-.local/sonari-dev/sui_wallets/admin/sui_config.yaml}"
SUI_CLIENT_ENV="${SUI_CLIENT_ENV:-testnet}"
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
SKIP_IDENTITY=0

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
    --sui-config)
      SUI_CLIENT_CONFIG="$2"
      shift 2
      ;;
    --sui-env)
      SUI_CLIENT_ENV="$2"
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

if [[ "$SUI_CLIENT_ENV" != "testnet" && "$SUI_CLIENT_ENV" != "devnet" && "$SUI_CLIENT_ENV" != "mainnet" ]]; then
  echo "--sui-env should be testnet, devnet, or mainnet" >&2
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
echo "gas budget:        $GAS_BUDGET"
if [[ "$SKIP_IDENTITY" -eq 1 ]]; then
  echo "identity:          skipped"
fi

echo "start register verifier configs"

LAST_TX_STATUS=0
LAST_TX_OUTPUT=""

register_family "earthquake" \
  "create_earthquake_verifier_config" \
  "update_earthquake_verifier_config_pcrs" \
  "$EARTHQUAKE_PCR0" "$EARTHQUAKE_PCR1" "$EARTHQUAKE_PCR2"

if [[ "$SKIP_IDENTITY" -ne 1 ]]; then
  register_family "membership identity" \
    "create_identity_verifier_config" \
    "update_identity_verifier_config_pcrs" \
    "$IDENTITY_PCR0" "$IDENTITY_PCR1" "$IDENTITY_PCR2"
fi

echo "all requested verifier configs registered"
