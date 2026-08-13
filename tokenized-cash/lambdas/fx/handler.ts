import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { resolveFxRate, putFxRate, convertCadToMxn, FX_SCALE } from "../../lib/fx";

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const path = event.path;
    const method = event.httpMethod;

    if (path === "/fx/rate" && method === "POST") {
      return await setFxRate(event);
    } else if (path === "/fx/rate" && method === "GET") {
      return await getFxRate();
    } else if (path === "/fx/convert" && method === "POST") {
      return await convert(event);
    }

    return respond(400, { error: "Unknown path/method" });
  } catch (err: any) {
    console.error("FX error:", err);
    return respond(500, { error: err.message });
  }
}

async function setFxRate(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || "{}");
  const { rate, setBy } = body;

  if (!rate || typeof rate !== "number" || rate <= 0) {
    return respond(400, { error: "rate must be a positive integer (e.g., 14045 = 14.045 CAD→MXN)" });
  }

  const record = await putFxRate(rate, setBy || "manual");

  return respond(200, {
    rate: record.rate,
    effectiveAt: record.effectiveAt,
    display: `${record.rate / FX_SCALE} CAD→MXN`,
    source: "manual",
  });
}

async function getFxRate(): Promise<APIGatewayProxyResult> {
  const latest = await resolveFxRate();
  return respond(200, {
    rate: latest.rate,
    display: `${latest.rate / FX_SCALE} CAD→MXN`,
    effectiveAt: latest.effectiveAt,
    source: latest.setBy,
  });
}

async function convert(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || "{}");
  const { cadAmount } = body;

  if (!cadAmount) {
    return respond(400, { error: "cadAmount required (in smallest unit)" });
  }

  const latest = await resolveFxRate();
  const mxnAmount = convertCadToMxn(BigInt(cadAmount), latest.rate);

  return respond(200, {
    cadAmount,
    mxnAmount: mxnAmount.toString(),
    rate: latest.rate,
    display: `${latest.rate / FX_SCALE} CAD→MXN`,
    source: latest.setBy,
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
