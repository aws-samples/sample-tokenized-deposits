import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { FxRateRecord } from "./types";

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME!;

// CAD->MXN rate is stored as an integer scaled by FX_SCALE (e.g. 14045 = 14.045).
export const FX_PK = "FX_RATE#CAD_MXN";
export const FX_SCALE = 1000;
export const CACHE_TTL_MS = 3600_000; // 1 hour

const BOC_API = "https://www.bankofcanada.ca/valet/observations/FXCADMXN/json?recent=1";

/** Fetch the latest CAD->MXN observation from the Bank of Canada Valet API. */
export async function fetchBocRate(): Promise<{ rate: number; date: string }> {
  const res = await fetch(BOC_API);
  if (!res.ok) throw new Error(`Bank of Canada API returned ${res.status}`);
  const data: any = await res.json();
  const obs = data.observations?.[0];
  if (!obs?.FXCADMXN?.v) throw new Error("No rate in Bank of Canada response");
  return {
    rate: Math.round(parseFloat(obs.FXCADMXN.v) * FX_SCALE),
    date: obs.d,
  };
}

/** Return the most recently stored rate (manual override or auto-fetched), or null. */
export async function getLatestCachedRate(): Promise<FxRateRecord | null> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": FX_PK },
      ScanIndexForward: false,
      Limit: 1,
    })
  );
  if (!result.Items || result.Items.length === 0) return null;
  return result.Items[0] as FxRateRecord;
}

/** Persist a rate (integer, already scaled by FX_SCALE) and return the stored record. */
export async function putFxRate(rate: number, setBy: string): Promise<FxRateRecord> {
  const now = Date.now();
  const record: FxRateRecord = {
    pk: FX_PK,
    sk: String(now),
    rate: Math.floor(rate),
    setBy,
    effectiveAt: now,
  };
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: record }));
  return record;
}

/**
 * Resolve the rate to use right now: a fresh cached rate if available,
 * otherwise a freshly fetched Bank of Canada rate (which is then cached),
 * falling back to a stale cached rate if the upstream fetch fails.
 * Throws only if there is neither a cached rate nor a reachable upstream.
 */
export async function resolveFxRate(): Promise<FxRateRecord> {
  const cached = await getLatestCachedRate();

  if (cached && Date.now() - cached.effectiveAt < CACHE_TTL_MS) {
    return cached;
  }

  try {
    const { rate, date } = await fetchBocRate();
    return await putFxRate(rate, `bankofcanada:${date}`);
  } catch (err: any) {
    if (cached) {
      console.warn("Bank of Canada API failed, using stale cache:", err.message);
      return cached;
    }
    throw new Error(`No cached rate and Bank of Canada API failed: ${err.message}`);
  }
}

/** Convert a CAD amount (smallest unit, bigint) to MXN using a scaled integer rate. */
export function convertCadToMxn(cadAmount: bigint, rate: number): bigint {
  return (cadAmount * BigInt(rate)) / BigInt(FX_SCALE);
}
