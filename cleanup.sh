#!/usr/bin/env bash
# ============================================================================
# cleanup.sh — Tear down all Tokenized Deposits Pilot infrastructure
#
# Destroys (in order):
#   1. TokenizedCashPilot CDK stack (Lambdas, API Gateway, DynamoDB, KMS keys)
#   2. Besu ValidatorFleet CDK stack (ECS, NLB, ASG)
#   3. Besu CommonInfra CDK stack (VPC, ECR, log groups)
#   4. Orphaned resources (CloudWatch log groups, ECR images)
#
# Usage:
#   ./cleanup.sh          # interactive (confirms each step)
#   ./cleanup.sh --yes    # non-interactive
# ============================================================================

set -euo pipefail

# --- Parse flags ---
AUTO_YES=false
for arg in "$@"; do
  case "$arg" in
    --yes|-y) AUTO_YES=true ;;
  esac
done

# --- Config ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BESU_DIR="$SCRIPT_DIR/besu-private-chain"
TOKENIZED_CASH="$SCRIPT_DIR/tokenized-cash"

# Source .env for AWS_ACCOUNT_ID, AWS_REGION, SHARD
if [[ -f "$BESU_DIR/.env" ]]; then
  source "$BESU_DIR/.env"
fi
export AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:?Set AWS_ACCOUNT_ID in besu-private-chain/.env}"
export AWS_REGION="${AWS_REGION:?Set AWS_REGION in besu-private-chain/.env}"
SHARD="${SHARD:-3}"

# Export credentials for CDK
eval "$(aws configure export-credentials --format env 2>/dev/null)" || true

# --- Helpers ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${YELLOW}[cleanup]${NC} $*"; }
ok()   { echo -e "${GREEN}  ✓${NC} $*"; }
err()  { echo -e "${RED}  ✗${NC} $*"; }

confirm() {
  if $AUTO_YES; then return 0; fi
  read -rp "  $1 [y/N] " ans
  [[ "$ans" =~ ^[Yy] ]]
}

# --- Derived names ---
APP_STACK="TokenizedCashPilot"
BESU_FLEET_STACK="dev-noderunners-${USER}-PrivateChainValidatorFleet"
BESU_INFRA_STACK="dev-noderunners-${USER}-PrivateChainCommonInfra"

echo ""
echo "=========================================="
echo " Tokenized Deposits Pilot — Full Cleanup"
echo "=========================================="
echo " Region:  $AWS_REGION"
echo " Account: $AWS_ACCOUNT_ID"
echo " Shard:   $SHARD"
echo " Stacks:  $APP_STACK"
echo "          $BESU_FLEET_STACK"
echo "          $BESU_INFRA_STACK"
echo "=========================================="
echo ""

# =============================================================================
# STEP 1: Destroy Application Stack
# =============================================================================
log "Step 1: Destroy application stack ($APP_STACK)"

if aws cloudformation describe-stacks --stack-name "$APP_STACK" --region "$AWS_REGION" &>/dev/null; then
  if confirm "Destroy $APP_STACK?"; then
    cd "$TOKENIZED_CASH"
    npx cdk destroy "$APP_STACK" --force --region "$AWS_REGION" 2>&1 || true
    ok "Application stack destroyed"
  fi
else
  ok "Stack $APP_STACK does not exist (already deleted)"
fi

# =============================================================================
# STEP 2: Clean up Route53 hosted zone records (prevents HostedZoneNotEmpty)
# =============================================================================
log "Step 2: Clean up Route53 hosted zone records"

HOSTED_ZONE_ID=$(aws route53 list-hosted-zones --query "HostedZones[?contains(Name,'privatechain')].Id" --output text 2>/dev/null | head -1 | sed 's|/hostedzone/||')
if [[ -n "$HOSTED_ZONE_ID" ]]; then
  log "  Found hosted zone: $HOSTED_ZONE_ID — removing non-required records"
  RECORDS=$(aws route53 list-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" --output json 2>/dev/null | \
    python3 -c "
import sys, json
data = json.load(sys.stdin)
records = data.get('ResourceRecordSets', [])
to_delete = [r for r in records if r['Type'] not in ('NS', 'SOA')]
if to_delete:
    changes = [{'Action': 'DELETE', 'ResourceRecordSet': r} for r in to_delete]
    print(json.dumps({'Changes': changes}))
" 2>/dev/null)
  if [[ -n "$RECORDS" ]]; then
    aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" --change-batch "$RECORDS" >/dev/null 2>&1 || true
    ok "Removed DNS records from hosted zone"
  else
    ok "No non-required records to remove"
  fi
else
  ok "No privatechain hosted zone found"
fi

# =============================================================================
# STEP 3: Destroy Besu stacks (cdk destroy --all)
# =============================================================================
log "Step 3: Destroy Besu stacks ($BESU_FLEET_STACK + $BESU_INFRA_STACK)"

BESU_FLEET_EXISTS=false
BESU_INFRA_EXISTS=false
aws cloudformation describe-stacks --stack-name "$BESU_FLEET_STACK" --region "$AWS_REGION" &>/dev/null && BESU_FLEET_EXISTS=true
aws cloudformation describe-stacks --stack-name "$BESU_INFRA_STACK" --region "$AWS_REGION" &>/dev/null && BESU_INFRA_EXISTS=true

if $BESU_FLEET_EXISTS || $BESU_INFRA_EXISTS; then
  if confirm "Destroy all Besu stacks?"; then
    cd "$BESU_DIR"
    npx cdk destroy --all --force --region "$AWS_REGION" 2>&1 || true
    ok "Besu stacks destroyed"
  fi
else
  ok "Besu stacks do not exist (already deleted)"
fi

# =============================================================================
# STEP 4: Clean up orphaned CloudWatch log groups
# =============================================================================
log "Step 4: Clean up CloudWatch log groups"

if confirm "Delete orphaned log groups (TokenizedCashPilot-*, Besu-*, noderunners-*)?"; then
  aws logs describe-log-groups --region "$AWS_REGION" --query "logGroups[].logGroupName" --output text 2>/dev/null | tr '\t' '\n' | \
    grep -E "(TokenizedCashPilot|BesuPrivateChain|Shard-?${SHARD}|dev-noderunners-${USER}|/metrics/besu|/var/log/besu)" | \
    while read -r lg; do
      log "  Deleting: $lg"
      aws logs delete-log-group --log-group-name "$lg" --region "$AWS_REGION" 2>/dev/null || true
    done
  ok "Log groups cleaned"
fi

# =============================================================================
# STEP 6: Delete ECR repository
# =============================================================================
log "Step 5: Delete ECR besu repository"

if aws ecr describe-repositories --repository-names besu --region "$AWS_REGION" &>/dev/null; then
  if confirm "Delete ECR repository 'besu' (and all images)?"; then
    aws ecr delete-repository --repository-name besu --region "$AWS_REGION" --force >/dev/null 2>&1
    ok "ECR repository deleted"
  fi
else
  ok "ECR repository 'besu' does not exist (already deleted)"
fi

# =============================================================================
# STEP 7: Clean local state
# =============================================================================
log "Step 6: Clean local state files"

if confirm "Remove local .deploy-state.json and cdk.context.json files?"; then
  rm -f "$SCRIPT_DIR/.deploy-state.json"
  rm -f "$TOKENIZED_CASH/cdk.context.json"
  rm -f "$BESU_DIR/cdk.context.json"
  ok "Local state cleaned"
fi

echo ""
echo "=========================================="
echo " Cleanup complete!"
echo "=========================================="
echo ""
echo " To redeploy from scratch:"
echo "   ./deploy.sh --yes"
echo ""
