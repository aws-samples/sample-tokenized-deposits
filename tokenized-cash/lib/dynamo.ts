import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { InstructionRecord, IdempotencyRecord, AuditRecord, RedemptionPostingRecord, CollateralLockRecord, ReconciliationRecord } from "./types";
import { LifecycleStatus, PostingStatus, CollateralStatus } from "./constants";

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.TABLE_NAME!;

export async function putInstruction(record: InstructionRecord): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: record,
      ConditionExpression: "attribute_not_exists(pk)",
    })
  );
}

export async function getInstruction(instructionId: string): Promise<InstructionRecord | null> {
  const result = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: instructionId, sk: "INSTRUCTION" },
    })
  );
  return (result.Item as InstructionRecord) || null;
}

export async function updateStatus(
  instructionId: string,
  newStatus: LifecycleStatus,
  extra?: Record<string, any>
): Promise<void> {
  let updateExpr = "SET #status = :status, #updatedAt = :now, #gsi = :gsi";
  const names: Record<string, string> = {
    "#status": "status",
    "#updatedAt": "updatedAt",
    "#gsi": "gsiStatus",
  };
  const values: Record<string, any> = {
    ":status": newStatus,
    ":now": Date.now(),
    ":gsi": `STATUS#${newStatus}`,
  };

  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      updateExpr += `, #${k} = :${k}`;
      names[`#${k}`] = k;
      values[`:${k}`] = v;
    }
  }

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: instructionId, sk: "INSTRUCTION" },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
}

export async function putIdempotency(record: IdempotencyRecord): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: record,
        ConditionExpression: "attribute_not_exists(pk)",
      })
    );
    return true;
  } catch (e: any) {
    if (e.name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

export async function getIdempotency(key: string): Promise<IdempotencyRecord | null> {
  const result = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: key, sk: "IDEMPOTENCY" },
    })
  );
  return (result.Item as IdempotencyRecord) || null;
}

export async function putAudit(record: AuditRecord): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: record }));
}

export async function queryByStatus(status: LifecycleStatus): Promise<InstructionRecord[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "gsi-status",
      KeyConditionExpression: "gsiStatus = :gsi",
      ExpressionAttributeValues: { ":gsi": `STATUS#${status}` },
    })
  );
  return (result.Items as InstructionRecord[]) || [];
}

// --- Redemption posting (off-chain MXN payout) helpers ---

export async function putRedemptionPosting(record: RedemptionPostingRecord): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: record,
      // pk+sk uniquely identify this REDEMPTION item; refuse to clobber an existing one.
      ConditionExpression: "attribute_not_exists(pk)",
    })
  );
}

export async function getRedemptionPosting(
  instructionId: string
): Promise<RedemptionPostingRecord | null> {
  const result = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: instructionId, sk: "REDEMPTION" },
    })
  );
  return (result.Item as RedemptionPostingRecord) || null;
}

export async function updateRedemptionPostingStatus(
  instructionId: string,
  newStatus: PostingStatus,
  extra?: Record<string, any>
): Promise<void> {
  let updateExpr = "SET #status = :status, #updatedAt = :now";
  const names: Record<string, string> = {
    "#status": "status",
    "#updatedAt": "updatedAt",
  };
  const values: Record<string, any> = {
    ":status": newStatus,
    ":now": Date.now(),
  };

  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      updateExpr += `, #${k} = :${k}`;
      names[`#${k}`] = k;
      values[`:${k}`] = v;
    }
  }

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: instructionId, sk: "REDEMPTION" },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      // Only update an existing posting.
      ConditionExpression: "attribute_exists(pk)",
    })
  );
}

// --- Transfer query helper (for collateral release tracing) ---

// --- Find LOCKED collateral records matching a burn amount ---

export async function queryLockedCollateral(): Promise<CollateralLockRecord[]> {
  const results: CollateralLockRecord[] = [];
  let scanKey: Record<string, any> | undefined = undefined;
  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: "sk = :sk AND #s = :locked",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":sk": "COLLATERAL",
          ":locked": "LOCKED",
        },
        ExclusiveStartKey: scanKey,
      })
    );
    results.push(...((result.Items as CollateralLockRecord[]) || []));
    scanKey = result.LastEvaluatedKey as Record<string, any> | undefined;
  } while (scanKey);
  return results;
}

// --- Collateral lock (off-chain CA segregated account) helpers ---

export async function putCollateralLock(record: CollateralLockRecord): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: record,
      ConditionExpression: "attribute_not_exists(pk)",
    })
  );
}

export async function getCollateralLock(
  instructionId: string
): Promise<CollateralLockRecord | null> {
  const result = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: instructionId, sk: "COLLATERAL" },
    })
  );
  return (result.Item as CollateralLockRecord) || null;
}

export async function updateCollateralLockStatus(
  instructionId: string,
  newStatus: CollateralStatus,
  extra?: Record<string, any>
): Promise<void> {
  let updateExpr = "SET #status = :status, #updatedAt = :now";
  const names: Record<string, string> = {
    "#status": "status",
    "#updatedAt": "updatedAt",
  };
  const values: Record<string, any> = {
    ":status": newStatus,
    ":now": Date.now(),
  };

  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      updateExpr += `, #${k} = :${k}`;
      names[`#${k}`] = k;
      values[`:${k}`] = v;
    }
  }

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: instructionId, sk: "COLLATERAL" },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: "attribute_exists(pk)",
    })
  );
}

// --- Reconciliation record helpers ---

export async function putReconciliation(record: ReconciliationRecord): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: record,
    })
  );
}

export async function getReconciliation(
  instructionId: string
): Promise<ReconciliationRecord | null> {
  const result = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: instructionId, sk: "RECONCILIATION" },
    })
  );
  return (result.Item as ReconciliationRecord) || null;
}
