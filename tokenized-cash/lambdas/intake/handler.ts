import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { randomBytes } from "crypto";
import { keccak256 as ethKeccak256 } from "ethers";
import { buildCsi, hashTypedData, idempotencyKey, clientIdempotencyKey } from "../../lib/csi";
import { KmsSigner } from "../../lib/kmsSigner";
import {
  putInstruction,
  putIdempotency,
  getIdempotency,
  getInstruction,
  putAudit,
  putRedemptionPosting,
  putCollateralLock,
} from "../../lib/dynamo";
import { resolveFxRate, convertCadToMxn } from "../../lib/fx";
import { CHAIN_ID, INTENT, LIFECYCLE_STATUS, POSTING_STATUS, COLLATERAL_STATUS } from "../../lib/constants";
import {
  InstructionRecord,
  IdempotencyRecord,
  AuditRecord,
  MintRequest,
  RedeemRequest,
  RedemptionPostingRecord,
  CollateralLockRecord,
} from "../../lib/types";

// Format smallest-unit bigint to readable token units (18 decimals).
function formatUnits(raw: string | bigint): string {
  const s = raw.toString();
  if (s.length <= 18) return `0.${s.padStart(18, "0").replace(/0+$/, "") || "0"}`;
  const whole = s.slice(0, s.length - 18);
  const frac = s.slice(s.length - 18).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

const KMS_KEY_ID_CA = process.env.KMS_KEY_ID_CA!;
const KMS_KEY_ID_MX = process.env.KMS_KEY_ID_MX!;
const SETTLEMENT_CONTRACT = process.env.SETTLEMENT_CONTRACT!;
const ALLOWED_CHAIN_ID = parseInt(process.env.ALLOWED_CHAIN_ID || String(CHAIN_ID));

const caSigner = new KmsSigner(KMS_KEY_ID_CA);
const mxSigner = new KmsSigner(KMS_KEY_ID_MX);

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const path = event.path;
    const body = JSON.parse(event.body || "{}");
    const clientKey = pickClientKey(event.headers, body);

    if (path === "/mint") {
      return await handleMint(body, clientKey);
    } else if (path === "/redeem") {
      return await handleRedeem(body, clientKey);
    }

    return respond(400, { error: "Unknown path" });
  } catch (err: any) {
    console.error("Intake error:", err);
    if (err.name === "ConditionalCheckFailedException") {
      return respond(409, { error: "Duplicate instruction" });
    }
    return respond(500, { error: err.message });
  }
}

// Case-insensitive header lookup (API Gateway preserves sender casing).
function headerCI(
  headers: APIGatewayProxyEvent["headers"],
  name: string
): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k] || undefined;
  }
  return undefined;
}

function pickClientKey(headers: APIGatewayProxyEvent["headers"], body: any): string | undefined {
  return headerCI(headers, "Idempotency-Key") || body?.idempotencyKey || undefined;
}

interface BusinessTuple {
  asset: string;
  amount: bigint;
  fromParty: string;
  toParty: string;
  intent: number;
  chainId: number;
}

// Opt-in idempotency: a client key or a reference yields a stable key (so retries
// dedupe and replay), while neither yields a unique key per request (so identical
// payments without an identifier are never conflated).
function resolveIdempotency(
  clientKey: string | undefined,
  reference: string | undefined,
  tuple: BusinessTuple
): { idemKey: string; messageDigest: string } {
  if (clientKey) {
    return {
      idemKey: clientIdempotencyKey(clientKey),
      messageDigest: ethKeccak256(new TextEncoder().encode(clientKey)),
    };
  }
  if (reference) {
    return {
      idemKey: idempotencyKey({ ...tuple, reference }),
      messageDigest: ethKeccak256(new TextEncoder().encode(reference)),
    };
  }
  const unique = "anon:" + randomBytes(32).toString("hex");
  return {
    idemKey: clientIdempotencyKey(unique),
    messageDigest: ethKeccak256(new TextEncoder().encode(unique)),
  };
}

// On a duplicate reservation, return the original instruction instead of creating a new one.
async function replayResponse(idemKey: string): Promise<APIGatewayProxyResult> {
  const existing = await getIdempotency(idemKey);
  if (existing?.instructionId) {
    const instr = await getInstruction(existing.instructionId);
    if (instr) {
      return respond(200, {
        instructionId: instr.pk,
        status: instr.status,
        signer: instr.signer,
        fxRate: instr.fxRate,
        mxnAmount: instr.mxnAmount,
        idempotentReplay: true,
      });
    }
  }
  // Reservation exists but the instruction isn't persisted yet (concurrent in-flight request).
  return respond(409, { error: "Request already in progress; retry shortly", idempotencyKey: idemKey });
}

async function handleMint(body: MintRequest, clientKey?: string): Promise<APIGatewayProxyResult> {
  const { asset, amount, toParty, reference, entity, segregatedAccountId } = body;
  if (!asset || !amount || !toParty) {
    return respond(400, { error: "Missing required fields: asset, amount, toParty" });
  }

  const amountBigInt = BigInt(amount);
  const now = Math.floor(Date.now() / 1000);
  const nonce = "0x" + randomBytes(32).toString("hex");
  const fromParty = "0x" + "00".repeat(20);

  const { idemKey, messageDigest } = resolveIdempotency(clientKey, reference, {
    asset,
    amount: amountBigInt,
    fromParty,
    toParty,
    intent: INTENT.MINT_ONLY,
    chainId: ALLOWED_CHAIN_ID,
  });

  const csi = buildCsi({
    messageDigest,
    asset,
    amount: amountBigInt,
    fromParty,
    toParty,
    valueTime: now,
    createdAt: now,
    expiry: now + 3600,
    intent: INTENT.MINT_ONLY,
    chainId: ALLOWED_CHAIN_ID,
    nonce,
  });

  const idempRecord: IdempotencyRecord = {
    pk: idemKey,
    sk: "IDEMPOTENCY",
    instructionId: csi.instructionId,
    createdAt: Date.now(),
    ttl: Math.floor(Date.now() / 1000) + 86400,
  };

  const isNew = await putIdempotency(idempRecord);
  if (!isNew) {
    return await replayResponse(idemKey);
  }

  // Sign with CA's KMS key (CA authorizes mints)
  const digest = hashTypedData(csi, SETTLEMENT_CONTRACT);
  const sigResult = await caSigner.signDigest(digest);

  const record: InstructionRecord = {
    pk: csi.instructionId,
    sk: "INSTRUCTION",
    status: LIFECYCLE_STATUS.FUNDED,
    entity: entity || "CA",
    intent: csi.intent,
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
    idempotencyKey: idemKey,
    reference,
    updatedAt: Date.now(),
    createdTimestamp: Date.now(),
    gsiStatus: `STATUS#${LIFECYCLE_STATUS.FUNDED}`,
  };

  await putInstruction(record);

  // Off-chain collateral lock: record the segregated account backing this mint.
  // Mirrors the RedemptionPostingRecord pattern on the MX side.
  const accountRef = segregatedAccountId || "ACCT-CA-SGR-DEFAULT";
  const collateral: CollateralLockRecord = {
    pk: csi.instructionId,
    sk: "COLLATERAL",
    status: COLLATERAL_STATUS.LOCKED,
    currency: "CAD",
    cadAmount: csi.amount.toString(),
    accountRef,
    reference,
    lockedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await putCollateralLock(collateral);

  await putAudit({
    pk: csi.instructionId,
    sk: `AUDIT#${Date.now()}#FUNDED`,
    status: LIFECYCLE_STATUS.FUNDED,
    timestamp: Date.now(),
    detail: `Mint instruction created — ${formatUnits(csi.amount)} tCAD. ` +
      `CAD collateral LOCKED in segregated account ${accountRef}`,
  });

  return respond(201, {
    instructionId: csi.instructionId,
    status: LIFECYCLE_STATUS.FUNDED,
    signer: sigResult.signer,
    collateral: { status: COLLATERAL_STATUS.LOCKED, accountRef },
  });
}

async function handleRedeem(body: RedeemRequest, clientKey?: string): Promise<APIGatewayProxyResult> {
  const { asset, amount, fromParty, toParty, reference, beneficiary } = body;
  if (!asset || !amount || !fromParty || !toParty) {
    return respond(400, { error: "Missing required fields: asset, amount, fromParty, toParty" });
  }

  const amountBigInt = BigInt(amount);
  const now = Math.floor(Date.now() / 1000);
  const nonce = "0x" + randomBytes(32).toString("hex");

  // Resolve and snapshot the FX rate BEFORE writing any state. A redemption must
  // record the rate it settled at, so if no rate is available we reject up front
  // rather than burning tokens without a recorded MXN obligation.
  let fxRate: number;
  let fxSource: string;
  let fxTimestamp: number;
  let mxnAmount: bigint;
  try {
    const fx = await resolveFxRate();
    fxRate = fx.rate;
    fxSource = fx.setBy;
    fxTimestamp = fx.effectiveAt;
    mxnAmount = convertCadToMxn(amountBigInt, fx.rate);
  } catch (err: any) {
    return respond(503, {
      error: "FX rate unavailable; cannot record redemption. Set a rate via POST /fx/rate and retry.",
      detail: err.message,
    });
  }

  const { idemKey, messageDigest } = resolveIdempotency(clientKey, reference, {
    asset,
    amount: amountBigInt,
    fromParty,
    toParty,
    intent: INTENT.BURN_ONLY,
    chainId: ALLOWED_CHAIN_ID,
  });

  const csi = buildCsi({
    messageDigest,
    asset,
    amount: amountBigInt,
    fromParty,
    toParty,
    valueTime: now,
    createdAt: now,
    expiry: now + 3600,
    intent: INTENT.BURN_ONLY,
    chainId: ALLOWED_CHAIN_ID,
    nonce,
  });

  const idempRecord: IdempotencyRecord = {
    pk: idemKey,
    sk: "IDEMPOTENCY",
    instructionId: csi.instructionId,
    createdAt: Date.now(),
    ttl: Math.floor(Date.now() / 1000) + 86400,
  };

  const isNew = await putIdempotency(idempRecord);
  if (!isNew) {
    return await replayResponse(idemKey);
  }

  // Sign with MX's KMS key (MX authorizes burns/redeems of their own tokens)
  const digest = hashTypedData(csi, SETTLEMENT_CONTRACT);
  const sigResult = await mxSigner.signDigest(digest);

  const mxnBeneficiary = beneficiary || "Bank ABC Mexico — MXN Operating Account";
  const nowMs = Date.now();

  const record: InstructionRecord = {
    pk: csi.instructionId,
    sk: "INSTRUCTION",
    status: LIFECYCLE_STATUS.FUNDED,
    entity: "MX",
    intent: csi.intent,
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
    fxRate,
    fxSource,
    fxTimestamp,
    mxnAmount: mxnAmount.toString(),
    idempotencyKey: idemKey,
    reference,
    updatedAt: nowMs,
    createdTimestamp: nowMs,
    gsiStatus: `STATUS#${LIFECYCLE_STATUS.FUNDED}`,
  };

  await putInstruction(record);

  // Off-chain MXN payout record: PENDING until the burn is confirmed on-chain,
  // then flipped to POSTED by the stage handler (simulated disbursement).
  const posting: RedemptionPostingRecord = {
    pk: csi.instructionId,
    sk: "REDEMPTION",
    status: POSTING_STATUS.PENDING,
    cadAmount: csi.amount.toString(),
    fxRate,
    fxSource,
    fxTimestamp,
    mxnAmount: mxnAmount.toString(),
    beneficiary: mxnBeneficiary,
    reference,
    createdAt: nowMs,
    updatedAt: nowMs,
  };
  await putRedemptionPosting(posting);

  await putAudit({
    pk: csi.instructionId,
    sk: `AUDIT#${Date.now()}#FUNDED`,
    status: LIFECYCLE_STATUS.FUNDED,
    timestamp: Date.now(),
    detail:
      `Redeem instruction created — ${formatUnits(csi.amount)} tCAD at ` +
      `${fxRate / 1000} CAD→MXN (${fxSource}). ` +
      `Off-chain MXN payout of ${formatUnits(mxnAmount)} MXN pending`,
  });

  return respond(201, {
    instructionId: csi.instructionId,
    status: LIFECYCLE_STATUS.FUNDED,
    signer: sigResult.signer,
    fxRate,
    fxSource,
    mxnAmount: mxnAmount.toString(),
    posting: { status: POSTING_STATUS.PENDING, beneficiary: mxnBeneficiary },
  });
}

function respond(statusCode: number, body: object): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(body),
  };
}
