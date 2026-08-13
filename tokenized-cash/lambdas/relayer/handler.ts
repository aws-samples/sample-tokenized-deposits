import { DynamoDBStreamEvent } from "aws-lambda";
import { JsonRpcProvider, Contract } from "ethers";
import { KmsTransactionSigner } from "../../lib/kmsSigner";
import { updateStatus, putAudit } from "../../lib/dynamo";
import { LIFECYCLE_STATUS } from "../../lib/constants";
import { InstructionRecord } from "../../lib/types";

const BESU_RPC_URL = process.env.BESU_RPC_URL!;
const KMS_KEY_ID_RELAYER = process.env.KMS_KEY_ID_RELAYER!;
const SETTLEMENT_CONTRACT = process.env.SETTLEMENT_CONTRACT!;

const SETTLEMENT_ABI = [
  "function settle(((" +
    "bytes32 instructionId,bytes32 messageDigest,address asset,uint256 amount," +
    "address fromParty,address toParty,uint64 valueTime,uint64 createdAt," +
    "uint64 expiry,uint8 intent,uint256 chainId,bytes32 nonce" +
  ") instruction, bytes signature) report) external",
];

let provider: JsonRpcProvider;
let signer: KmsTransactionSigner;
let contract: Contract;

function init() {
  if (!provider) {
    provider = new JsonRpcProvider(BESU_RPC_URL);
    signer = new KmsTransactionSigner(KMS_KEY_ID_RELAYER, provider);
    contract = new Contract(SETTLEMENT_CONTRACT, SETTLEMENT_ABI, signer);
  }
}

export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  init();

  for (const record of event.Records) {
    if (record.eventName !== "MODIFY" && record.eventName !== "INSERT") continue;

    const newImage = record.dynamodb?.NewImage;
    if (!newImage) continue;

    const status = newImage.status?.S;
    const sk = newImage.sk?.S;
    if (status !== LIFECYCLE_STATUS.FUNDED || sk !== "INSTRUCTION") continue;

    const instructionId = newImage.pk?.S!;
    const instruction = unmarshallInstruction(newImage);

    try {
      const report = {
        instruction: {
          instructionId: instruction.instructionId,
          messageDigest: instruction.messageDigest,
          asset: instruction.asset,
          amount: BigInt(instruction.amount),
          fromParty: instruction.fromParty,
          toParty: instruction.toParty,
          valueTime: instruction.valueTime,
          createdAt: instruction.createdAt,
          expiry: instruction.expiry,
          intent: instruction.intent,
          chainId: instruction.chainId,
          nonce: instruction.nonce,
        },
        signature: instruction.signature,
      };

      const tx = await contract.settle(report, { type: 0, gasPrice: 0, gasLimit: 2_000_000 });
      const receipt = await tx.wait();

      await updateStatus(instructionId, LIFECYCLE_STATUS.SUBMITTED, {
        txHash: receipt.hash,
      });

      await putAudit({
        pk: instructionId,
        sk: `AUDIT#${Date.now()}#SUBMITTED`,
        status: LIFECYCLE_STATUS.SUBMITTED,
        timestamp: Date.now(),
        detail: `Tx submitted to Besu`,
        txHash: receipt.hash,
      });

      console.log(`Relayer: ${instructionId} submitted, tx=${receipt.hash}`);
    } catch (err: any) {
      console.error(`Relayer error for ${instructionId}:`, err.message);
      await updateStatus(instructionId, LIFECYCLE_STATUS.FAILED, {
        failureReason: err.message?.slice(0, 500),
      });
      await putAudit({
        pk: instructionId,
        sk: `AUDIT#${Date.now()}#FAILED`,
        status: LIFECYCLE_STATUS.FAILED,
        timestamp: Date.now(),
        detail: `Relayer submission failed: ${err.message?.slice(0, 200)}`,
      });
    }
  }
}

function unmarshallInstruction(image: any): InstructionRecord & { instructionId: string } {
  return {
    instructionId: image.pk?.S || "",
    pk: image.pk?.S || "",
    sk: image.sk?.S || "",
    status: image.status?.S as any,
    entity: image.entity?.S || "CA",
    intent: parseInt(image.intent?.N || "0"),
    asset: image.asset?.S || "",
    amount: image.amount?.S || "0",
    fromParty: image.fromParty?.S || "",
    toParty: image.toParty?.S || "",
    valueTime: parseInt(image.valueTime?.N || "0"),
    createdAt: parseInt(image.createdAt?.N || "0"),
    expiry: parseInt(image.expiry?.N || "0"),
    chainId: parseInt(image.chainId?.N || "0"),
    nonce: image.nonce?.S || "",
    messageDigest: image.messageDigest?.S || "",
    signature: image.signature?.S || "",
    signer: image.signer?.S || "",
    idempotencyKey: image.idempotencyKey?.S || "",
    reference: image.reference?.S,
    updatedAt: parseInt(image.updatedAt?.N || "0"),
    createdTimestamp: parseInt(image.createdTimestamp?.N || "0"),
    gsiStatus: image.gsiStatus?.S || "",
  };
}
