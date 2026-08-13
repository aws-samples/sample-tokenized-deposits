export type Intent = 'MINT_ONLY' | 'BURN_AND_MINT' | 'BURN_ONLY';
export type Status = 'FUNDED' | 'SUBMITTED' | 'MINTED' | 'TRANSFERRED' | 'BURNED' | 'FAILED';
export type Entity = 'CA' | 'MX';

export interface MintResponse {
  instructionId: string;
  status: Status;
  signer: string;
}

export interface FxRate {
  rate: number;
  display: string;
  effectiveAt: number;
  setBy: string;
}

export interface Settings {
  apiKey: string;
  apiBaseUrl: string;
  rpcUrl: string;
  tokenAddress: string;
  settlementConsumerAddress: string;
  caWallet: string;
  mxWallet: string;
}

export interface InstructionSummary {
  instructionId: string;
  status: Status;
  entity: Entity;
  intent: number;
  asset: string;
  amount: string;
  fromParty: string;
  toParty: string;
  reference?: string;
  txHash?: string;
  createdTimestamp: number;
  updatedAt: number;
}

export interface AuditEntry {
  status: string;
  timestamp: number;
  detail: string;
  txHash?: string;
}

export interface CollateralInfo {
  status: 'LOCKED' | 'RELEASED' | 'FAILED';
  currency: string;
  cadAmount: string;
  accountRef: string;
  lockedAt: number;
  releasedAt?: number;
  updatedAt: number;
}

export interface RedemptionInfo {
  status: 'PENDING' | 'POSTED' | 'FAILED';
  cadAmount: string;
  fxRate: number;
  fxSource: string;
  mxnAmount: string;
  beneficiary: string;
  createdAt: number;
  postedAt?: number;
}

export interface ReconciliationInfo {
  status: 'MATCHED' | 'MISMATCH';
  burnAmount: string;
  collateralReleased: string;
  mxnPosted: string;
  fxRate: number;
  burnTxHash?: string;
  mintInstructionId?: string;
  collateralAccountRef?: string;
  reconciledAt: number;
}

export interface InstructionDetail {
  instructionId: string;
  status: Status;
  entity: Entity;
  intent: number;
  asset: string;
  amount: string;
  fromParty: string;
  toParty: string;
  valueTime: number;
  createdAt: number;
  expiry: number;
  chainId: number;
  signer?: string;
  txHash?: string;
  reference?: string;
  updatedAt: number;
  createdTimestamp: number;
  collateral?: CollateralInfo | null;
  redemption?: RedemptionInfo | null;
  reconciliation?: ReconciliationInfo | null;
  audit: AuditEntry[];
}

export const INTENT_NAMES: Record<number, Intent> = {
  0: 'MINT_ONLY',
  1: 'BURN_AND_MINT',
  2: 'BURN_ONLY',
};
