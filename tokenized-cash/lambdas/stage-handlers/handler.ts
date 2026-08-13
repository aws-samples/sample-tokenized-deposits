import { EventBridgeEvent } from "aws-lambda";
import { randomBytes } from "crypto";
import { keccak256 as ethKeccak256 } from "ethers";
import { buildCsi, hashTypedData } from "../../lib/csi";
import { KmsSigner } from "../../lib/kmsSigner";
import { putInstruction, getInstruction, updateStatus, putAudit, getRedemptionPosting, updateRedemptionPostingStatus, getCollateralLock, updateCollateralLockStatus, queryLockedCollateral, putReconciliation } from "../../lib/dynamo";
import { CHAIN_ID, INTENT, LIFECYCLE_STATUS, ENTITY, POSTING_STATUS, COLLATERAL_STATUS, RECONCILIATION_STATUS } from "../../lib/constants";
import { InstructionRecord, ReconciliationRecord } from "../../lib/types";

// Format smallest-unit bigint to readable token units (18 decimals).
function formatUnits(raw: string | bigint): string {
  const s = raw.toString();
  if (s.length <= 18) return `0.${s.padStart(18, "0").replace(/0+$/, "") || "0"}`;
  const whole = s.slice(0, s.length - 18);
  const frac = s.slice(s.length - 18).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

const KMS_KEY_ID_CA = process.env.KMS_KEY_ID_CA!;
const SETTLEMENT_CONTRACT = process.env.SETTLEMENT_CONTRACT!;
const ALLOWED_CHAIN_ID = parseInt(process.env.ALLOWED_CHAIN_ID || String(CHAIN_ID));
const MX_WALLET = process.env.MX_WALLET!;

const caSigner = new KmsSigner(KMS_KEY_ID_CA);

interface LifecycleDetail {
  instructionId: string;
  status: string;
  intent: number;
  entity: string;
  asset: string;
  amount: string;
  fromParty: string;
  toParty: string;
  txHash?: string;
}

export async function handler(
  event: EventBridgeEvent<"SettlementLifecycle", LifecycleDetail>
): Promise<void> {
  const detail = event.detail;
  console.log(`Stage handler: ${detail.instructionId} status=${detail.status} entity=${detail.entity}`);

  switch (detail.status) {
    case LIFECYCLE_STATUS.MINTED:
      await handleMinted(detail);
      break;
    case LIFECYCLE_STATUS.TRANSFERRED:
      await handleTransferred(detail);
      break;
    case LIFECYCLE_STATUS.BURNED:
      await handleBurned(detail);
      break;
    default:
      console.log(`Stage handler: no action for status=${detail.status}`);
  }
}

async function handleMinted(detail: LifecycleDetail): Promise<void> {
  // After MINT on CA side → initiate BURN_AND_MINT (transfer CA→MX)
  if (detail.entity !== ENTITY.CA) return;

  const now = Math.floor(Date.now() / 1000);
  const nonce = "0x" + randomBytes(32).toString("hex");
  const messageDigest = ethKeccak256(
    new TextEncoder().encode(`transfer-${detail.instructionId}`)
  );

  const csi = buildCsi({
    messageDigest,
    asset: detail.asset,
    amount: BigInt(detail.amount),
    fromParty: detail.toParty, // CA wallet that just got minted
    toParty: MX_WALLET,
    valueTime: now,
    createdAt: now,
    expiry: now + 3600,
    intent: INTENT.BURN_AND_MINT,
    chainId: ALLOWED_CHAIN_ID,
    nonce,
  });

  const digest = hashTypedData(csi, SETTLEMENT_CONTRACT);
  const sigResult = await caSigner.signDigest(digest);

  const record: InstructionRecord = {
    pk: csi.instructionId,
    sk: "INSTRUCTION",
    status: LIFECYCLE_STATUS.FUNDED,
    entity: ENTITY.CA,
    intent: INTENT.BURN_AND_MINT,
    asset: csi.asset,
    amount: csi.amount.toString(),
    fromParty: csi.fromParty,
    toParty: csi.toParty,
    valueTime: csi.valueTime,
    createdAt: csi.createdAt,
    expiry: csi.expiry,
    chainId: csi.chainId,
    nonce: csi.nonce,
    messageDigest: csi.messageDigest,
    signature: sigResult.signature,
    signer: sigResult.signer,
    idempotencyKey: `transfer-${detail.instructionId}`,
    reference: `transfer from mint ${detail.instructionId}`,
    updatedAt: Date.now(),
    createdTimestamp: Date.now(),
    gsiStatus: `STATUS#${LIFECYCLE_STATUS.FUNDED}`,
  };

  await putInstruction(record);
  await putAudit({
    pk: csi.instructionId,
    sk: `AUDIT#${Date.now()}#FUNDED`,
    status: LIFECYCLE_STATUS.FUNDED,
    timestamp: Date.now(),
    detail: `Transfer CA→MX initiated from mint ${detail.instructionId}`,
  });

  await putAudit({
    pk: detail.instructionId,
    sk: `AUDIT#${Date.now()}#TRANSFER_INITIATED`,
    status: LIFECYCLE_STATUS.MINTED,
    timestamp: Date.now(),
    detail: `Transfer ${csi.instructionId} created for CA→MX`,
  });

  console.log(`Stage: created transfer ${csi.instructionId} (CA→MX)`);
}

async function handleTransferred(detail: LifecycleDetail): Promise<void> {
  // After BURN_AND_MINT confirmed → MX now has tokens.
  if (detail.intent !== INTENT.BURN_AND_MINT) return;

  console.log(`Stage: transfer confirmed ${detail.instructionId}, MX has tokens at ${detail.toParty}`);

  await putAudit({
    pk: detail.instructionId,
    sk: `AUDIT#${Date.now()}#TRANSFER_COMPLETE`,
    status: LIFECYCLE_STATUS.TRANSFERRED,
    timestamp: Date.now(),
    detail: `Transfer confirmed, MX wallet ${detail.toParty} funded`,
  });

  // Add audit to the original mint so it shows the transfer completed.
  const transfer = await getInstruction(detail.instructionId);
  const mintId = transfer?.reference?.replace("transfer from mint ", "");
  if (mintId) {
    await putAudit({
      pk: mintId,
      sk: `AUDIT#${Date.now()}#TRANSFER_COMPLETE`,
      status: LIFECYCLE_STATUS.MINTED,
      timestamp: Date.now(),
      detail: `Auto-transfer to MX confirmed — ${detail.instructionId.slice(0, 10)}...`,
    });
  }
}

async function handleBurned(detail: LifecycleDetail): Promise<void> {
  // Final burn confirmed. For a redemption (BURN_ONLY), the on-chain claim is now
  // destroyed, so post the off-chain MXN disbursement (simulated) before reconciling.
  console.log(`Stage: burn confirmed ${detail.instructionId}, entity=${detail.entity}`);

  if (detail.intent === INTENT.BURN_ONLY) {
    const posting = await getRedemptionPosting(detail.instructionId);
    if (posting && posting.status === POSTING_STATUS.PENDING) {
      const postedAt = Date.now();
      await updateRedemptionPostingStatus(detail.instructionId, POSTING_STATUS.POSTED, { postedAt });
      await putAudit({
        pk: detail.instructionId,
        sk: `AUDIT#${Date.now()}#MXN_POSTED`,
        status: LIFECYCLE_STATUS.BURNED,
        timestamp: postedAt,
        detail:
          `Off-chain MXN disbursement posted (simulated): ${formatUnits(posting.mxnAmount)} MXN ` +
          `at ${posting.fxRate / 1000} CAD→MXN (${posting.fxSource})`,
      });
    } else if (!posting) {
      console.warn(`Stage: no redemption posting found for ${detail.instructionId} (legacy redeem?)`);
    }

    // Release CA collateral and write reconciliation record.
    const collateralResult = await releaseCollateralForBurn(detail);

    // Reconciliation: compare on-chain burn with off-chain obligations.
    const reconciledAt = Date.now();
    const collateralReleased = collateralResult?.cadAmount || "0";
    const mxnPosted = posting?.mxnAmount || "0";
    const amountsMatch = collateralReleased === detail.amount && posting != null;

    const reconciliation: ReconciliationRecord = {
      pk: detail.instructionId,
      sk: "RECONCILIATION",
      status: amountsMatch ? RECONCILIATION_STATUS.MATCHED : RECONCILIATION_STATUS.MISMATCH,
      burnAmount: detail.amount,
      collateralReleased,
      mxnPosted,
      fxRate: posting?.fxRate || 0,
      burnTxHash: detail.txHash,
      mintInstructionId: collateralResult?.mintId,
      collateralAccountRef: collateralResult?.accountRef,
      reconciledAt,
    };
    await putReconciliation(reconciliation);

    await putAudit({
      pk: detail.instructionId,
      sk: `AUDIT#${Date.now()}#RECONCILED`,
      status: LIFECYCLE_STATUS.BURNED,
      timestamp: reconciledAt,
      detail: amountsMatch
        ? `Reconciled: ${formatUnits(detail.amount)} tCAD burned = ${formatUnits(collateralReleased)} CAD released + ${formatUnits(mxnPosted)} MXN posted`
        : `Reconciliation MISMATCH: burned ${formatUnits(detail.amount)} tCAD, collateral ${formatUnits(collateralReleased)} CAD, MXN ${formatUnits(mxnPosted)}`,
    });
  } else {
    await putAudit({
      pk: detail.instructionId,
      sk: `AUDIT#${Date.now()}#RECONCILED`,
      status: LIFECYCLE_STATUS.BURNED,
      timestamp: Date.now(),
      detail: `Burn confirmed for entity=${detail.entity}`,
    });
  }
}

interface CollateralReleaseResult {
  mintId: string;
  cadAmount: string;
  accountRef: string;
}

async function releaseCollateralForBurn(detail: LifecycleDetail): Promise<CollateralReleaseResult | null> {
  // Find any LOCKED collateral and release (fully or partially) to cover the burn amount.
  const locked = await queryLockedCollateral();

  if (locked.length === 0) {
    console.warn(`Stage: no LOCKED collateral found`);
    return null;
  }

  // Sort oldest first (FIFO — release earliest collateral first).
  locked.sort((a, b) => (a.lockedAt || 0) - (b.lockedAt || 0));

  const burnAmount = BigInt(detail.amount);
  let released = BigInt(0);
  let lastMintId = "";
  let lastAccountRef = "";

  for (const lock of locked) {
    if (released >= burnAmount) break;

    const lockAmount = BigInt(lock.cadAmount);
    const mintId = lock.pk;
    const releasedAt = Date.now();
    const needed = burnAmount - released;

    if (lockAmount <= needed) {
      // Full release of this collateral record.
      await updateCollateralLockStatus(mintId, COLLATERAL_STATUS.RELEASED, { releasedAt });
      await putAudit({
        pk: mintId,
        sk: `AUDIT#${Date.now()}#COLLATERAL_RELEASED`,
        status: LIFECYCLE_STATUS.BURNED,
        timestamp: releasedAt,
        detail: `CAD collateral fully released from ${lock.accountRef} — ${formatUnits(lock.cadAmount)} CAD`,
      });
      released += lockAmount;
      console.log(`Stage: collateral fully released for mint ${mintId.slice(0, 10)}...`);
    } else {
      // Partial release — reduce the locked amount, keep status LOCKED.
      const remaining = lockAmount - needed;
      await updateCollateralLockStatus(mintId, COLLATERAL_STATUS.LOCKED, {
        cadAmount: remaining.toString(),
        releasedAmount: needed.toString(),
      });
      await putAudit({
        pk: mintId,
        sk: `AUDIT#${Date.now()}#COLLATERAL_PARTIAL_RELEASE`,
        status: LIFECYCLE_STATUS.BURNED,
        timestamp: releasedAt,
        detail: `CAD collateral partially released from ${lock.accountRef} — ${formatUnits(needed.toString())} CAD released, ${formatUnits(remaining.toString())} CAD still locked`,
      });
      released += needed;
      console.log(`Stage: collateral partially released for mint ${mintId.slice(0, 10)}... (${formatUnits(remaining.toString())} CAD remains locked)`);
    }

    lastMintId = mintId;
    lastAccountRef = lock.accountRef;
  }

  if (released === BigInt(0)) return null;
  return { mintId: lastMintId, cadAmount: released.toString(), accountRef: lastAccountRef };
}
