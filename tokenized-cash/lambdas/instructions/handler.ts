import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME!;

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const path = event.path;
    const method = event.httpMethod;

    // GET /instructions/:id — single instruction + audit trail
    if (path.startsWith("/instructions/") && method === "GET") {
      const instructionId = path.split("/instructions/")[1];
      if (!instructionId) return respond(400, { error: "instructionId required" });
      return await getInstruction(instructionId);
    }

    // GET /instructions — list all (optionally filter by status)
    if (path === "/instructions" && method === "GET") {
      const status = event.queryStringParameters?.status;
      return await listInstructions(status);
    }

    return respond(400, { error: "Unknown path" });
  } catch (err: any) {
    console.error("Instructions handler error:", err);
    return respond(500, { error: err.message });
  }
}

async function getInstruction(instructionId: string): Promise<APIGatewayProxyResult> {
  // Get the instruction record
  const instrResult = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: instructionId, sk: "INSTRUCTION" },
    })
  );

  if (!instrResult.Item) {
    return respond(404, { error: "Instruction not found" });
  }

  // Get audit trail
  const auditResult = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": instructionId,
        ":prefix": "AUDIT#",
      },
      ScanIndexForward: true,
    })
  );

  // Get the off-chain MXN redemption posting, if any (redemptions only)
  const postingResult = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: instructionId, sk: "REDEMPTION" },
    })
  );

  // Get the off-chain CA collateral lock, if any (mints only)
  const collateralResult = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: instructionId, sk: "COLLATERAL" },
    })
  );

  // Get reconciliation record, if any (burn/redeem only)
  const reconResult = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: instructionId, sk: "RECONCILIATION" },
    })
  );

  const instruction = instrResult.Item;
  const audit = (auditResult.Items || []).map((item) => ({
    status: item.status,
    timestamp: item.timestamp,
    detail: item.detail,
    txHash: item.txHash,
  }));

  const p = postingResult.Item;
  const redemption = p
    ? {
        status: p.status,
        cadAmount: p.cadAmount,
        fxRate: p.fxRate,
        fxSource: p.fxSource,
        fxTimestamp: p.fxTimestamp,
        mxnAmount: p.mxnAmount,
        beneficiary: p.beneficiary,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        postedAt: p.postedAt,
      }
    : null;

  const c = collateralResult.Item;
  const collateral = c
    ? {
        status: c.status,
        currency: c.currency,
        cadAmount: c.cadAmount,
        accountRef: c.accountRef,
        lockedAt: c.lockedAt,
        releasedAt: c.releasedAt,
        updatedAt: c.updatedAt,
      }
    : null;

  const r = reconResult.Item;
  const reconciliation = r
    ? {
        status: r.status,
        burnAmount: r.burnAmount,
        collateralReleased: r.collateralReleased,
        mxnPosted: r.mxnPosted,
        fxRate: r.fxRate,
        burnTxHash: r.burnTxHash,
        mintInstructionId: r.mintInstructionId,
        collateralAccountRef: r.collateralAccountRef,
        reconciledAt: r.reconciledAt,
      }
    : null;

  return respond(200, {
    instructionId: instruction.pk,
    status: instruction.status,
    entity: instruction.entity,
    intent: instruction.intent,
    asset: instruction.asset,
    amount: instruction.amount,
    fromParty: instruction.fromParty,
    toParty: instruction.toParty,
    valueTime: instruction.valueTime,
    createdAt: instruction.createdAt,
    expiry: instruction.expiry,
    chainId: instruction.chainId,
    signer: instruction.signer,
    txHash: instruction.txHash,
    fxRate: instruction.fxRate,
    fxSource: instruction.fxSource,
    fxTimestamp: instruction.fxTimestamp,
    mxnAmount: instruction.mxnAmount,
    reference: instruction.reference,
    updatedAt: instruction.updatedAt,
    createdTimestamp: instruction.createdTimestamp,
    collateral,
    redemption,
    reconciliation,
    audit,
  });
}

async function listInstructions(status?: string): Promise<APIGatewayProxyResult> {
  let items: any[];

  if (status) {
    // Query by status using GSI
    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: "gsi-status",
        KeyConditionExpression: "gsiStatus = :gsi",
        ExpressionAttributeValues: { ":gsi": `STATUS#${status}` },
        ScanIndexForward: false,
      })
    );
    items = result.Items || [];
  } else {
    // Scan for all INSTRUCTION records with pagination
    items = [];
    let lastKey: any = undefined;
    do {
      const result = await ddb.send(
        new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: "sk = :sk",
          ExpressionAttributeValues: { ":sk": "INSTRUCTION" },
          ExclusiveStartKey: lastKey,
        })
      );
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey;
    } while (lastKey && items.length < 200);
  }

  const instructions = items
    .filter((item) => item.sk === "INSTRUCTION")
    .map((item) => ({
      instructionId: item.pk,
      status: item.status,
      entity: item.entity,
      intent: item.intent,
      asset: item.asset,
      amount: item.amount,
      fromParty: item.fromParty,
      toParty: item.toParty,
      reference: item.reference,
      txHash: item.txHash,
      createdTimestamp: item.createdTimestamp,
      updatedAt: item.updatedAt,
    }))
    .sort((a, b) => (b.createdTimestamp || 0) - (a.createdTimestamp || 0));

  return respond(200, { instructions, count: instructions.length });
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
