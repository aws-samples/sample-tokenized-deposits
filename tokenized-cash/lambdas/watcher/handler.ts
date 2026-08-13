import { DynamoDBStreamEvent } from "aws-lambda";
import { JsonRpcProvider, Contract } from "ethers";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { updateStatus, putAudit } from "../../lib/dynamo";
import { LIFECYCLE_STATUS, INTENT, LifecycleStatus } from "../../lib/constants";

const BESU_RPC_URL = process.env.BESU_RPC_URL!;
const SETTLEMENT_CONTRACT = process.env.SETTLEMENT_CONTRACT!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME || "default";
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 15; // 15 * 2s = 30s max

const CONSUMER_ABI = ["function executed(bytes32) view returns (bool)"];

let provider: JsonRpcProvider;
let contract: Contract;
const eventBridge = new EventBridgeClient({});

function init() {
  if (!provider) {
    provider = new JsonRpcProvider(BESU_RPC_URL);
    contract = new Contract(SETTLEMENT_CONTRACT, CONSUMER_ABI, provider);
  }
}

export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  init();

  for (const record of event.Records) {
    if (record.eventName !== "MODIFY") continue;

    const newImage = record.dynamodb?.NewImage;
    if (!newImage) continue;
    if (newImage.status?.S !== LIFECYCLE_STATUS.SUBMITTED) continue;
    if (newImage.sk?.S !== "INSTRUCTION") continue;

    const instructionId = newImage.pk?.S;
    if (!instructionId) continue;

    const intent = parseInt(newImage.intent?.N || "0");
    const entity = newImage.entity?.S || "";
    const asset = newImage.asset?.S || "";
    const amount = newImage.amount?.S || "";
    const fromParty = newImage.fromParty?.S || "";
    const toParty = newImage.toParty?.S || "";
    const txHash = newImage.txHash?.S;

    console.log(`Watcher: polling for ${instructionId.slice(0, 10)}... execution`);

    const confirmed = await pollUntilExecuted(instructionId);
    if (!confirmed) {
      console.warn(`Watcher: ${instructionId.slice(0, 10)}... not confirmed after ${MAX_POLLS} polls`);
      continue;
    }

    const nextStatus = advanceStatus(intent);
    await updateStatus(instructionId, nextStatus);
    await putAudit({
      pk: instructionId,
      sk: `AUDIT#${Date.now()}#${nextStatus}`,
      status: nextStatus,
      timestamp: Date.now(),
      detail: `On-chain confirmed: executed(${instructionId}) = true`,
      txHash,
    });

    await emitLifecycleEvent({
      instructionId,
      status: nextStatus,
      intent,
      entity,
      asset,
      amount,
      fromParty,
      toParty,
      txHash,
    });

    console.log(`Watcher: ${instructionId.slice(0, 10)}... → ${nextStatus}`);
  }
}

async function pollUntilExecuted(instructionId: string): Promise<boolean> {
  for (let i = 0; i < MAX_POLLS; i++) {
    try {
      const isExecuted: boolean = await contract.executed(instructionId);
      if (isExecuted) return true;
    } catch (err: any) {
      console.error(`Watcher: poll error for ${instructionId.slice(0, 10)}...`, err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

function advanceStatus(intent: number): LifecycleStatus {
  switch (intent) {
    case INTENT.MINT_ONLY:
      return LIFECYCLE_STATUS.MINTED;
    case INTENT.BURN_AND_MINT:
      return LIFECYCLE_STATUS.TRANSFERRED;
    case INTENT.BURN_ONLY:
      return LIFECYCLE_STATUS.BURNED;
    default:
      return LIFECYCLE_STATUS.MINTED;
  }
}

interface LifecycleEvent {
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

async function emitLifecycleEvent(detail: LifecycleEvent): Promise<void> {
  await eventBridge.send(
    new PutEventsCommand({
      Entries: [
        {
          Source: "tokenized-cash.watcher",
          DetailType: "SettlementLifecycle",
          EventBusName: EVENT_BUS_NAME,
          Detail: JSON.stringify(detail),
        },
      ],
    })
  );
}
