#!/usr/bin/env bash
# =============================================================================
# Tokenized Deposits Pilot — Automated Deployment Script
#
# Orchestrates the full deployment: KMS bootstrap → key generation → Besu →
# contracts → CDK redeploy → E2E verification.
#
# Prerequisites:
#   - AWS CLI configured with appropriate credentials
#   - CDK bootstrapped (npx cdk bootstrap)
#   - Foundry installed (forge)
#   - Node.js 20+
#   - docker or finch (for Besu image push to ECR)
#
# Usage:
#   ./deploy.sh                    # Full deploy (interactive prompts)
#   ./deploy.sh --from-step 3     # Resume from step 3 (Besu)
#   ./deploy.sh --dry-run          # Show what would be done
# =============================================================================
set -euo pipefail

# --- Configuration -----------------------------------------------------------
AWS_REGION="${AWS_REGION:-us-west-2}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
BESU_IMAGE_TAG="${BESU_IMAGE_TAG:-hyperledger/besu:24.7.0}"
SHARD="${SHARD:-3}"

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
TOKENIZED_CASH="$PROJECT_ROOT/tokenized-cash"
BESU_DIR="$PROJECT_ROOT/besu-private-chain"
STATE_FILE="$PROJECT_ROOT/.deploy-state.json"

FROM_STEP="${FROM_STEP:-1}"
DRY_RUN=false
AUTO_YES=false

# --- Parse Arguments ---------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-step) FROM_STEP="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --yes|-y) AUTO_YES=true; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# --- Detect container runtime (docker first, fallback to finch) --------------
if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
  CONTAINER_RT="docker"
elif command -v finch &>/dev/null; then
  CONTAINER_RT="finch"
else
  echo "ERROR: Neither docker nor finch is available. Install one to continue." >&2
  exit 1
fi

# --- Ensure CDK can resolve AWS credentials ----------------------------------
# CDK doesn't always pick up credential_process from profiles. Export explicitly.
if [[ -z "${AWS_ACCESS_KEY_ID:-}" ]] && command -v aws &>/dev/null; then
  eval "$(aws configure export-credentials --format env 2>/dev/null)" || true
fi

# --- Helpers -----------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

log()   { echo -e "${BLUE}[deploy]${NC} $*"; }
ok()    { echo -e "${GREEN}[  OK  ]${NC} $*"; }
warn()  { echo -e "${YELLOW}[ WARN ]${NC} $*"; }
err()   { echo -e "${RED}[ERROR ]${NC} $*" >&2; }
step()  { echo -e "\n${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; echo -e "${GREEN} Step $1: $2${NC}"; echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"; }

confirm() {
  if $DRY_RUN; then log "[dry-run] Would execute: $1"; return 1; fi
  if $AUTO_YES; then log "▸ $1 [auto-yes]"; return 0; fi
  read -rp "$(echo -e "${YELLOW}▸ $1 [Y/n]: ${NC}")" answer
  [[ "${answer:-Y}" =~ ^[Yy] ]]
}

save_state() {
  node -e "
    const fs = require('fs');
    const existing = fs.existsSync('$STATE_FILE') ? JSON.parse(fs.readFileSync('$STATE_FILE', 'utf8')) : {};
    const update = JSON.parse(process.argv[1]);
    fs.writeFileSync('$STATE_FILE', JSON.stringify({ ...existing, ...update }, null, 2));
  " "$1"
}

load_state() {
  if [[ -f "$STATE_FILE" ]]; then
    node -e "const s = JSON.parse(require('fs').readFileSync('$STATE_FILE','utf8')); console.log(s['$1'] || '')"
  fi
}

require_state() {
  local val
  val=$(load_state "$1")
  if [[ -z "$val" ]]; then
    if $DRY_RUN; then
      echo "<$1>"
      return 0
    fi
    err "Missing state: $1 (expected from a previous step)"
    err "If resuming, ensure $STATE_FILE has the required values or re-run from an earlier step."
    exit 1
  fi
  echo "$val"
}

# Extract value after "Key = " pattern from CDK output (macOS-compatible)
extract_cdk_output() {
  local key="$1" file="$2"
  sed -n "s/.*${key} = \([a-f0-9-]*\).*/\1/p" "$file" | head -1
}

# Extract 0x address from a line containing a label
extract_address() {
  echo "$1" | sed -n 's/.*\(0x[a-fA-F0-9]\{40\}\).*/\1/p'
}

# Extract 0x private key (64 hex chars) from a line
extract_privkey() {
  echo "$1" | sed -n 's/.*\(0x[a-fA-F0-9]\{64\}\).*/\1/p'
}

# Check whether CDK is bootstrapped in the target account/region.
# Returns 0 if bootstrapped, 1 otherwise.
is_cdk_bootstrapped() {
  # The modern bootstrap stack publishes its version as an SSM parameter.
  # This is the same check the CDK CLI uses, so it's the most reliable signal.
  if aws ssm get-parameter \
       --name "/cdk-bootstrap/hnb659fds/version" \
       --region "$AWS_REGION" >/dev/null 2>&1; then
    return 0
  fi
  # Fallback: presence of a healthy CDKToolkit stack.
  local status
  status=$(aws cloudformation describe-stacks \
    --stack-name CDKToolkit \
    --region "$AWS_REGION" \
    --query "Stacks[0].StackStatus" --output text 2>/dev/null || true)
  case "$status" in
    CREATE_COMPLETE|UPDATE_COMPLETE|IMPORT_COMPLETE|UPDATE_ROLLBACK_COMPLETE) return 0 ;;
    *) return 1 ;;
  esac
}

# Ensure CDK is bootstrapped before any cdk deploy runs.
ensure_cdk_bootstrap() {
  if $DRY_RUN; then
    if is_cdk_bootstrapped; then
      log "[dry-run] CDK already bootstrapped in aws://$AWS_ACCOUNT_ID/$AWS_REGION"
    else
      log "[dry-run] Would run: npx cdk bootstrap aws://$AWS_ACCOUNT_ID/$AWS_REGION"
    fi
    return 0
  fi

  if is_cdk_bootstrapped; then
    ok "CDK already bootstrapped in aws://$AWS_ACCOUNT_ID/$AWS_REGION"
    return 0
  fi

  warn "CDK is not bootstrapped in aws://$AWS_ACCOUNT_ID/$AWS_REGION."
  if confirm "Bootstrap CDK now (npx cdk bootstrap aws://$AWS_ACCOUNT_ID/$AWS_REGION)?"; then
    cd "$TOKENIZED_CASH"
    npm install --silent
    npx cdk bootstrap "aws://$AWS_ACCOUNT_ID/$AWS_REGION" --require-approval never
    if is_cdk_bootstrapped; then
      ok "CDK bootstrap complete"
    else
      err "CDK bootstrap ran but the environment still appears un-bootstrapped."
      exit 1
    fi
  else
    err "CDK bootstrap is required before deployment can continue."
    err "Run manually: npx cdk bootstrap aws://$AWS_ACCOUNT_ID/$AWS_REGION"
    exit 1
  fi
}

# Ensure Foundry (forge) is available; offer to install via the official
# foundryup installer if missing. Foundry is only needed for the step 4
# contract compile, so callers should gate this on FROM_STEP <= 4.
ensure_foundry() {
  # Already on PATH?
  if command -v forge &>/dev/null; then
    ok "Foundry present ($(forge --version 2>/dev/null | head -1))"
    return 0
  fi

  # Installed previously but not on PATH in this shell?
  if [[ -x "$HOME/.foundry/bin/forge" ]]; then
    export PATH="$HOME/.foundry/bin:$PATH"
    ok "Foundry found in ~/.foundry/bin (added to PATH)"
    return 0
  fi

  if $DRY_RUN; then
    log "[dry-run] Would install Foundry via https://foundry.paradigm.xyz (foundryup)"
    return 0
  fi

  warn "Foundry (forge) is not installed — required to compile contracts in step 4."
  if confirm "Install Foundry now (downloads and runs the official foundryup installer)?"; then
    if ! command -v curl &>/dev/null; then
      err "curl is required to install Foundry. Install curl, or install Foundry manually: https://getfoundry.sh"
      exit 1
    fi
    log "Installing foundryup..."
    curl -L https://foundry.paradigm.xyz | bash
    # foundryup installs to ~/.foundry/bin; add to PATH for this session, then run it
    export PATH="$HOME/.foundry/bin:$PATH"
    log "Running foundryup to install forge/cast/anvil..."
    foundryup
    if command -v forge &>/dev/null; then
      ok "Foundry installed ($(forge --version 2>/dev/null | head -1))"
    else
      err "Foundry install ran but 'forge' is still not on PATH."
      err "Add ~/.foundry/bin to your PATH (or open a new shell), then re-run with --from-step 4."
      exit 1
    fi
  else
    err "Foundry is required before deployment can continue."
    err "Install: curl -L https://foundry.paradigm.xyz | bash && foundryup  (see https://getfoundry.sh)"
    exit 1
  fi
}

# =============================================================================
# STEP 0: Preflight — ensure required tooling is ready
# =============================================================================
# CDK is used to deploy in steps 1, 3, and 5. Bootstrap is a per-account/region
# prerequisite, so we verify it once up front regardless of --from-step.
# Foundry is only needed for the step 4 contract compile, so it is checked only
# when the run will reach step 4 — failing fast before any infrastructure is
# provisioned rather than after the Besu fleet is up.
step 0 "Preflight — Tooling Checks"
ensure_cdk_bootstrap
if [[ "$FROM_STEP" -le 4 ]]; then
  ensure_foundry
fi

# =============================================================================
# STEP 1: Bootstrap KMS Keys (CDK first pass)
# =============================================================================
if [[ "$FROM_STEP" -le 1 ]]; then
  step 1 "Bootstrap KMS Keys (CDK first pass)"

  log "This deploys the CDK stack to create KMS signing keys (CA, MX, relayer)."
  log "Lambdas won't function yet — on-chain context is added in step 5."

  cd "$TOKENIZED_CASH"
  npm install --silent

  if confirm "Deploy CDK stack (KMS bootstrap)?"; then
    rm -f cdk.context.json
    npx cdk deploy --require-approval never 2>&1 | tee /tmp/cdk-bootstrap.log

    # Extract KMS key IDs from CDK output
    KMS_KEY_ID_CA=$(extract_cdk_output "CaKmsKeyId" /tmp/cdk-bootstrap.log)
    KMS_KEY_ID_MX=$(extract_cdk_output "MxKmsKeyId" /tmp/cdk-bootstrap.log)
    KMS_KEY_ID_RELAYER=$(extract_cdk_output "RelayerKmsKeyId" /tmp/cdk-bootstrap.log)

    # Fallback: query CloudFormation if grep missed
    if [[ -z "$KMS_KEY_ID_CA" ]]; then
      STACK_NAME=$(aws cloudformation list-stacks --region "$AWS_REGION" \
        --query "StackSummaries[?StackStatus!='DELETE_COMPLETE' && contains(StackName,'tokenized-cash')].StackName" \
        --output text | head -1)
      if [[ -n "$STACK_NAME" ]]; then
        KMS_KEY_ID_CA=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
          --query "Stacks[0].Outputs[?OutputKey=='CaKmsKeyId'].OutputValue" --output text)
        KMS_KEY_ID_MX=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
          --query "Stacks[0].Outputs[?OutputKey=='MxKmsKeyId'].OutputValue" --output text)
        KMS_KEY_ID_RELAYER=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
          --query "Stacks[0].Outputs[?OutputKey=='RelayerKmsKeyId'].OutputValue" --output text)
      fi
    fi

    if [[ -z "$KMS_KEY_ID_CA" || -z "$KMS_KEY_ID_MX" || -z "$KMS_KEY_ID_RELAYER" ]]; then
      err "Could not extract KMS key IDs from CDK output."
      err "Please enter them manually (from the CloudFormation console):"
      read -rp "  CaKmsKeyId: " KMS_KEY_ID_CA
      read -rp "  MxKmsKeyId: " KMS_KEY_ID_MX
      read -rp "  RelayerKmsKeyId: " KMS_KEY_ID_RELAYER
    fi

    save_state "{\"kmsKeyIdCa\":\"$KMS_KEY_ID_CA\",\"kmsKeyIdMx\":\"$KMS_KEY_ID_MX\",\"kmsKeyIdRelayer\":\"$KMS_KEY_ID_RELAYER\"}"
    ok "KMS keys created"
    ok "  CA:      $KMS_KEY_ID_CA"
    ok "  MX:      $KMS_KEY_ID_MX"
    ok "  Relayer: $KMS_KEY_ID_RELAYER"
  fi
fi

# =============================================================================
# STEP 2: Generate Deployer Key + Derive Relayer Address
# =============================================================================
if [[ "$FROM_STEP" -le 2 ]]; then
  step 2 "Generate Deployer Key + Derive Relayer Address"

  KMS_KEY_ID_RELAYER=$(require_state "kmsKeyIdRelayer")

  if $DRY_RUN; then
    log "[dry-run] Would run: generate-deployer-relayer.ts (KMS_KEY_ID_RELAYER=$KMS_KEY_ID_RELAYER)"
  else
    cd "$TOKENIZED_CASH"
    log "Generating deployer keypair and deriving relayer address from KMS..."

    OUTPUT=$(KMS_KEY_ID_RELAYER="$KMS_KEY_ID_RELAYER" AWS_REGION="$AWS_REGION" npx ts-node scripts/generate-deployer-relayer.ts 2>&1)
    echo "$OUTPUT"

    # Parse addresses and key from output
    DEPLOYER_ADDRESS=$(extract_address "$(echo "$OUTPUT" | grep 'Deployer' -A2 | grep 'Address')")
    DEPLOYER_KEY=$(extract_privkey "$(echo "$OUTPUT" | grep 'Private Key')")
    RELAYER_ADDRESS=$(extract_address "$(echo "$OUTPUT" | grep 'Relayer' -A2 | grep 'Address')")

    if [[ -z "$DEPLOYER_ADDRESS" || -z "$DEPLOYER_KEY" || -z "$RELAYER_ADDRESS" ]]; then
      err "Failed to parse deployer/relayer output. Check above."
      exit 1
    fi

    save_state "{\"deployerAddress\":\"$DEPLOYER_ADDRESS\",\"deployerKey\":\"$DEPLOYER_KEY\",\"relayerAddress\":\"$RELAYER_ADDRESS\"}"
    ok "Deployer: $DEPLOYER_ADDRESS"
    ok "Relayer:  $RELAYER_ADDRESS"
  fi
fi

# =============================================================================
# STEP 3: Deploy Besu Network
# =============================================================================
if [[ "$FROM_STEP" -le 3 ]]; then
  step 3 "Deploy Besu Network"

  # 3a: Push Besu image to ECR
  cd "$BESU_DIR"
  if confirm "Pull and push Besu image to ECR (using $CONTAINER_RT)?"; then
    log "Pulling Besu image..."
    $CONTAINER_RT pull --platform linux/arm64 "$BESU_IMAGE_TAG"

    ECR_URI="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/besu:latest"
    $CONTAINER_RT tag "$BESU_IMAGE_TAG" "$ECR_URI"

    log "Authenticating with ECR..."
    aws ecr get-login-password --region "$AWS_REGION" | \
      $CONTAINER_RT login --username AWS --password-stdin "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
    aws ecr create-repository --repository-name besu --region "$AWS_REGION" 2>/dev/null || true

    log "Pushing image..."
    $CONTAINER_RT push "$ECR_URI"
    ok "Besu image pushed to ECR"
  fi

  # 3c: Setup .env
  if ! $DRY_RUN; then
    cd "$BESU_DIR"
    npm install --silent
    if [[ ! -f .env ]]; then
      cp .env-sample .env
      sed -i.bak "s/xxxxxxxxxxx/$AWS_ACCOUNT_ID/" .env
      sed -i.bak "s/us-east-1/$AWS_REGION/" .env
      sed -i.bak "s/SHARD=3/SHARD=$SHARD/" .env
      rm -f .env.bak
      log "Created .env (SHARD=$SHARD)"
    fi
    source .env
    export AWS_ACCOUNT_ID AWS_REGION SHARD
  fi

  # 3d: First deploy (infra only)
  if confirm "Deploy Besu infrastructure (first pass, 0 validators)?"; then
    FIRST_DEPLOY=1 npx tsc && FIRST_DEPLOY=1 npx cdk deploy "dev-noderunners-${USER}-PrivateChainValidatorFleet" --require-approval never
    ok "Besu infrastructure deployed"
  fi

  # 3e: Generate validator keys
  if confirm "Generate validator keys?"; then
    FIRST_DEPLOY=1 ./scripts/generate-keys.sh
    ok "Validator keys generated"
  fi

  # 3f: Second deploy (4 validators)
  if confirm "Deploy Besu validators (second pass)?"; then
    npx tsc && npx cdk deploy "dev-noderunners-${USER}-PrivateChainValidatorFleet" --require-approval never
    ok "Besu validators deployed"
  fi

  # 3g: Get NLB DNS
  if $DRY_RUN; then
    log "[dry-run] Would query NLB DNS and VPC ID from AWS"
  else
    log "Waiting for NLB to be available..."
    NLB_DNS=$(aws elbv2 describe-load-balancers --region "$AWS_REGION" \
      --query "LoadBalancers[?Scheme=='internal'].[DNSName]" --output text | head -1)

    if [[ -z "$NLB_DNS" ]]; then
      warn "Could not auto-detect NLB DNS. Please enter it manually:"
      read -rp "  NLB DNS: " NLB_DNS
    fi

    # Get VPC ID from Besu stack
    BESU_VPC_ID=$(aws ec2 describe-vpcs --region "$AWS_REGION" \
      --filters "Name=tag:Name,Values=*noderunners*" \
      --query "Vpcs[0].VpcId" --output text 2>/dev/null || true)

    if [[ -z "$BESU_VPC_ID" || "$BESU_VPC_ID" == "None" ]]; then
      warn "Could not auto-detect Besu VPC ID. Please enter it manually:"
      read -rp "  VPC ID: " BESU_VPC_ID
    fi

    save_state "{\"nlbDns\":\"$NLB_DNS\",\"besuVpcId\":\"$BESU_VPC_ID\"}"
    ok "Besu network running"
    ok "  NLB DNS: $NLB_DNS"
    ok "  VPC ID:  $BESU_VPC_ID"
  fi
fi

# =============================================================================
# STEP 4: Deploy Contracts
# =============================================================================
if [[ "$FROM_STEP" -le 4 ]]; then
  step 4 "Deploy Contracts"

  DEPLOYER_KEY=$(require_state "deployerKey")
  KMS_KEY_ID_CA=$(require_state "kmsKeyIdCa")
  KMS_KEY_ID_MX=$(require_state "kmsKeyIdMx")
  KMS_KEY_ID_RELAYER=$(require_state "kmsKeyIdRelayer")

  # 4a: Compile
  if $DRY_RUN; then
    log "[dry-run] Would compile contracts with forge"
  else
    cd "$TOKENIZED_CASH/contracts"
    log "Compiling contracts (EVM target: london)..."
    forge build --via-ir --optimizer-runs 200
    ok "Contracts compiled"
  fi

  # 4b: Deploy via SSM
  cd "$TOKENIZED_CASH"
  if confirm "Deploy contracts to Besu via SSM?"; then
    OUTPUT=$(DEPLOYER_KEY="$DEPLOYER_KEY" \
      KMS_KEY_ID_CA="$KMS_KEY_ID_CA" \
      KMS_KEY_ID_MX="$KMS_KEY_ID_MX" \
      KMS_KEY_ID_RELAYER="$KMS_KEY_ID_RELAYER" \
      AWS_REGION="$AWS_REGION" \
      npx ts-node scripts/deploy-contracts-via-ssm.ts 2>&1)
    echo "$OUTPUT"

    SETTLEMENT_CONTRACT=$(extract_address "$(echo "$OUTPUT" | grep 'SettlementConsumer:' | tail -1)")
    TOKEN_ADDRESS=$(extract_address "$(echo "$OUTPUT" | grep 'Token (tCAD):' | tail -1)")
    CA_WALLET=$(extract_address "$(echo "$OUTPUT" | grep 'CA Signer:' | tail -1)")
    MX_WALLET=$(extract_address "$(echo "$OUTPUT" | grep 'MX Signer:' | tail -1)")

    if [[ -z "$SETTLEMENT_CONTRACT" || -z "$TOKEN_ADDRESS" ]]; then
      err "Failed to parse contract addresses. Enter manually:"
      read -rp "  SettlementConsumer address: " SETTLEMENT_CONTRACT
      read -rp "  Token address: " TOKEN_ADDRESS
      read -rp "  CA wallet: " CA_WALLET
      read -rp "  MX wallet: " MX_WALLET
    fi

    save_state "{\"settlementContract\":\"$SETTLEMENT_CONTRACT\",\"tokenAddress\":\"$TOKEN_ADDRESS\",\"caWallet\":\"$CA_WALLET\",\"mxWallet\":\"$MX_WALLET\"}"
    ok "Contracts deployed"
    ok "  SettlementConsumer: $SETTLEMENT_CONTRACT"
    ok "  Token (tCAD):       $TOKEN_ADDRESS"
    ok "  CA Wallet:          $CA_WALLET"
    ok "  MX Wallet:          $MX_WALLET"
  fi
fi

# =============================================================================
# STEP 5: Redeploy Application Stack (CDK with full context)
# =============================================================================
if [[ "$FROM_STEP" -le 5 ]]; then
  step 5 "Redeploy Application Stack (CDK — full context)"

  BESU_VPC_ID=$(require_state "besuVpcId")
  NLB_DNS=$(require_state "nlbDns")
  SETTLEMENT_CONTRACT=$(require_state "settlementContract")
  TOKEN_ADDRESS=$(require_state "tokenAddress")
  CA_WALLET=$(require_state "caWallet")
  MX_WALLET=$(require_state "mxWallet")

  cd "$TOKENIZED_CASH"
  if confirm "Redeploy CDK with on-chain context?"; then
    rm -f cdk.context.json
    npx cdk deploy --require-approval never \
      -c besuVpcId="$BESU_VPC_ID" \
      -c besuRpcUrl="http://$NLB_DNS:80" \
      -c settlementContract="$SETTLEMENT_CONTRACT" \
      -c tokenAddress="$TOKEN_ADDRESS" \
      -c mxWallet="$MX_WALLET"

    # Get API key
    API_KEY=$(aws apigateway get-api-keys --region "$AWS_REGION" --include-values \
      --query "items[?name=='tokenized-cash-pilot-key'].value" --output text)
    API_URL=$(aws cloudformation describe-stacks --stack-name TokenizedCashPilot --region "$AWS_REGION" \
      --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" \
      --output text)

    save_state "{\"apiKey\":\"$API_KEY\",\"apiUrl\":\"$API_URL\"}"

    # Generate web-ui .env for local dashboard
    cat > "$TOKENIZED_CASH/web-ui/.env" <<EOF
VITE_API_BASE_URL=${API_URL%/}
VITE_API_KEY=$API_KEY
VITE_CA_WALLET=$CA_WALLET
VITE_MX_WALLET=$MX_WALLET
VITE_TOKEN_ADDRESS=$TOKEN_ADDRESS
VITE_SETTLEMENT_CONTRACT=$SETTLEMENT_CONTRACT
EOF
    ok "Application stack deployed"
    ok "  API URL: $API_URL"
    ok "  API Key: ${API_KEY:0:8}..."
    ok "  web-ui/.env written"
  fi
fi

# =============================================================================
# STEP 6: Verify E2E
# =============================================================================
if [[ "$FROM_STEP" -le 6 ]]; then
  step 6 "End-to-End Verification"

  API_URL=$(require_state "apiUrl")
  API_KEY=$(require_state "apiKey")
  CA_WALLET=$(require_state "caWallet")
  MX_WALLET=$(require_state "mxWallet")
  TOKEN_ADDRESS=$(require_state "tokenAddress")

  cd "$TOKENIZED_CASH"
  if confirm "Run E2E test?"; then
    API_URL="$API_URL" \
    API_KEY="$API_KEY" \
    CA_WALLET="$CA_WALLET" \
    MX_WALLET="$MX_WALLET" \
    TOKEN_ADDR="$TOKEN_ADDRESS" \
    npx ts-node scripts/e2e-test.ts

    ok "E2E test passed"
  fi
fi

# =============================================================================
# Done
# =============================================================================
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN} Deployment Complete${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
log "State saved to: $STATE_FILE"
log "To launch the dashboard locally:"
log "  cd tokenized-cash/web-ui && npm install && npm run dev"
echo ""
