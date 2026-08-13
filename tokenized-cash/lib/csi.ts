import { keccak256, AbiCoder, solidityPacked, TypedDataEncoder } from "ethers";
import { CHAIN_ID, DOMAIN_NAME, DOMAIN_VERSION } from "./constants";

export interface CanonicalSettlementInstruction {
  instructionId: string; // bytes32 hex
  messageDigest: string; // bytes32 hex
  asset: string; // address
  amount: bigint;
  fromParty: string; // address
  toParty: string; // address
  valueTime: number; // uint64
  createdAt: number; // uint64
  expiry: number; // uint64
  intent: number; // uint8
  chainId: number; // uint256
  nonce: string; // bytes32 hex
}

const CSI_TYPE = {
  CanonicalSettlementInstruction: [
    { name: "instructionId", type: "bytes32" },
    { name: "messageDigest", type: "bytes32" },
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "fromParty", type: "address" },
    { name: "toParty", type: "address" },
    { name: "valueTime", type: "uint64" },
    { name: "createdAt", type: "uint64" },
    { name: "expiry", type: "uint64" },
    { name: "intent", type: "uint8" },
    { name: "chainId", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

export function deriveInstructionId(params: {
  messageDigest: string;
  asset: string;
  amount: bigint;
  fromParty: string;
  toParty: string;
  valueTime: number;
  intent: number;
  chainId: number;
  createdAt: number;
  expiry: number;
  nonce: string;
}): string {
  const packed = solidityPacked(
    ["string", "bytes32", "address", "uint256", "address", "address", "uint64", "uint8", "uint256", "uint64", "uint64", "bytes32"],
    [
      "CSI_V1",
      params.messageDigest,
      params.asset,
      params.amount,
      params.fromParty,
      params.toParty,
      params.valueTime,
      params.intent,
      params.chainId,
      params.createdAt,
      params.expiry,
      params.nonce,
    ]
  );
  return keccak256(packed);
}

/**
 * Derives a stable idempotency key from durable request fields only, so that
 * retrying the same logical request yields the same key and is deduplicated.
 */
export function idempotencyKey(params: {
  asset: string;
  amount: bigint;
  fromParty: string;
  toParty: string;
  intent: number;
  chainId: number;
  reference: string;
}): string {
  const refHash = params.reference
    ? keccak256(new TextEncoder().encode(params.reference))
    : "0x" + "00".repeat(32);
  const packed = solidityPacked(
    ["string", "address", "uint256", "address", "address", "uint8", "uint256", "bytes32"],
    [
      "CSI_IDEMPOTENCY_V2",
      params.asset,
      params.amount,
      params.fromParty,
      params.toParty,
      params.intent,
      params.chainId,
      refHash,
    ]
  );
  return keccak256(packed);
}

/** Derives an idempotency key from a caller-supplied request id. */
export function clientIdempotencyKey(clientRequestId: string): string {
  return keccak256(new TextEncoder().encode("CSI_CLIENT_IDEMPOTENCY_V1:" + clientRequestId));
}

export function hashTypedData(
  csi: CanonicalSettlementInstruction,
  verifyingContract: string
): string {
  const domain = {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: csi.chainId,
    verifyingContract,
  };
  const message = {
    instructionId: csi.instructionId,
    messageDigest: csi.messageDigest,
    asset: csi.asset,
    amount: csi.amount,
    fromParty: csi.fromParty,
    toParty: csi.toParty,
    valueTime: csi.valueTime,
    createdAt: csi.createdAt,
    expiry: csi.expiry,
    intent: csi.intent,
    chainId: csi.chainId,
    nonce: csi.nonce,
  };
  return TypedDataEncoder.hash(domain, CSI_TYPE, message);
}

export function buildCsi(params: {
  messageDigest: string;
  asset: string;
  amount: bigint;
  fromParty: string;
  toParty: string;
  valueTime: number;
  createdAt: number;
  expiry: number;
  intent: number;
  chainId: number;
  nonce: string;
}): CanonicalSettlementInstruction {
  const instructionId = deriveInstructionId(params);
  return {
    instructionId,
    ...params,
  };
}
