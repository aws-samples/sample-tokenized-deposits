import { LifecycleStatus, PostingStatus, CollateralStatus, ReconciliationStatus } from "./constants";

export interface InstructionRecord {
  pk: string; // instructionId (bytes32 hex)
  sk: string; // "INSTRUCTION"
  status: LifecycleStatus;
  entity: string; // "CA" | "MX"
  intent: number;
  asset: string;
  amount: string; // stringified bigint
  fromParty: string;
  toParty: string;
  valueTime: number;
  createdAt: number;
  expiry: number;
  chainId: number;
  nonce: string;
  messageDigest: string;
  signature?: string;
  signer?: string;
  txHash?: string;
  fxRate?: number; // integer basis: 14045 = 14.045
  fxSource?: string; // e.g. "bankofcanada:2026-06-04" or "manual"
  fxTimestamp?: number; // epoch ms the rate was effective when snapshotted
  mxnAmount?: string; // MXN owed at redemption (smallest unit, stringified bigint)
  idempotencyKey: string;
  reference?: string;
  updatedAt: number;
  createdTimestamp: number;
  gsiStatus: string; // "STATUS#FUNDED" etc for GSI queries
}

export interface IdempotencyRecord {
  pk: string; // idempotency key hex
  sk: string; // "IDEMPOTENCY"
  instructionId: string;
  createdAt: number;
  ttl: number;
}

export interface AuditRecord {
  pk: string; // instructionId
  sk: string; // "AUDIT#<timestamp>#<status>"
  status: LifecycleStatus;
  timestamp: number;
  detail?: string;
  txHash?: string;
}

export interface FxRateRecord {
  pk: string; // "FX_RATE#CAD_MXN"
  sk: string; // timestamp
  rate: number; // integer: 14045 means 14.045
  setBy: string;
  effectiveAt: number;
}

// Off-chain MXN payout record for a redemption (BURN_ONLY) instruction.
// Snapshots the FX rate used and tracks the simulated disbursement lifecycle.
export interface RedemptionPostingRecord {
  pk: string; // instructionId (same partition as the INSTRUCTION + AUDIT items)
  sk: string; // "REDEMPTION"
  status: PostingStatus; // PENDING -> POSTED (or FAILED)
  cadAmount: string; // tCAD burned (smallest unit, stringified bigint)
  fxRate: number; // integer basis: 14045 = 14.045
  fxSource: string; // "bankofcanada:<date>" or "manual"
  fxTimestamp: number; // epoch ms the rate was effective
  mxnAmount: string; // MXN owed (smallest unit, stringified bigint)
  beneficiary: string; // off-chain MXN beneficiary reference (mock)
  reference?: string;
  createdAt: number;
  updatedAt: number;
  postedAt?: number; // epoch ms the (simulated) MXN disbursement was posted
}

// Off-chain CA collateral lock record for a mint (MINT_ONLY) instruction.
// Tracks the segregated account that backs the minted tokens.
export interface CollateralLockRecord {
  pk: string; // instructionId (same partition as the INSTRUCTION + AUDIT items)
  sk: string; // "COLLATERAL"
  status: CollateralStatus; // LOCKED -> RELEASED (or FAILED)
  currency: string; // "CAD"
  cadAmount: string; // amount locked (smallest unit, stringified bigint)
  accountRef: string; // segregated account reference
  reference?: string;
  lockedAt: number; // epoch ms
  releasedAt?: number; // epoch ms when collateral was released
  updatedAt: number;
}

// Reconciliation record: proves on-chain burn matches off-chain obligations.
export interface ReconciliationRecord {
  pk: string; // instructionId (the BURN_ONLY instruction)
  sk: string; // "RECONCILIATION"
  status: ReconciliationStatus;
  burnAmount: string; // tCAD burned on-chain (smallest unit)
  collateralReleased: string; // CAD released from segregated account
  mxnPosted: string; // MXN disbursed off-chain
  fxRate: number; // rate used for conversion
  burnTxHash?: string; // on-chain proof
  mintInstructionId?: string; // traced-back original mint
  collateralAccountRef?: string;
  reconciledAt: number;
}

export interface MintRequest {
  asset: string;
  amount: string;
  toParty: string;
  reference?: string;
  entity?: string; // defaults to "CA"
  idempotencyKey?: string; // optional client-supplied key for deduplication
  segregatedAccountId?: string; // CA collateral account reference (e.g. "ACCT-CA-SGR-001")
}

export interface RedeemRequest {
  asset: string;
  amount: string;
  fromParty: string;
  toParty: string;
  reference?: string;
  beneficiary?: string; // off-chain MXN beneficiary reference; defaults to toParty
  idempotencyKey?: string; // optional client-supplied key for deduplication
}
