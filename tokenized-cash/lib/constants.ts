export const CHAIN_ID = 70924;

export const DOMAIN_NAME = "SettlementInstruction";
export const DOMAIN_VERSION = "1";

export const INTENT = {
  MINT_ONLY: 0,
  BURN_AND_MINT: 1,
  BURN_ONLY: 2,
} as const;


export const LIFECYCLE_STATUS = {
  FUNDED: "FUNDED",
  SUBMITTED: "SUBMITTED",
  MINTED: "MINTED",
  TRANSFERRED: "TRANSFERRED",
  BURNED: "BURNED",
  FAILED: "FAILED",
} as const;

export type LifecycleStatus = (typeof LIFECYCLE_STATUS)[keyof typeof LIFECYCLE_STATUS];

export const ENTITY = {
  CA: "CA",
  MX: "MX",
} as const;

// Off-chain MXN payout lifecycle for redemption posting records.
export const POSTING_STATUS = {
  PENDING: "PENDING",
  POSTED: "POSTED",
  FAILED: "FAILED",
} as const;

export type PostingStatus = (typeof POSTING_STATUS)[keyof typeof POSTING_STATUS];

// CA segregated-account collateral lock lifecycle.
export const COLLATERAL_STATUS = {
  LOCKED: "LOCKED",
  RELEASED: "RELEASED",
  FAILED: "FAILED",
} as const;

export type CollateralStatus = (typeof COLLATERAL_STATUS)[keyof typeof COLLATERAL_STATUS];

// Reconciliation outcome after burn confirms.
export const RECONCILIATION_STATUS = {
  MATCHED: "MATCHED",
  MISMATCH: "MISMATCH",
} as const;

export type ReconciliationStatus = (typeof RECONCILIATION_STATUS)[keyof typeof RECONCILIATION_STATUS];
