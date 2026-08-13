import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { JsonRpcProvider, Contract, formatUnits } from "ethers";

const BESU_RPC_URL = process.env.BESU_RPC_URL!;
const SETTLEMENT_CONTRACT = process.env.SETTLEMENT_CONTRACT!;
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS!;

const TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

const CONSUMER_ABI = [
  "function executed(bytes32) view returns (bool)",
];

let provider: JsonRpcProvider;

function init() {
  if (!provider) {
    provider = new JsonRpcProvider(BESU_RPC_URL);
  }
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  init();

  try {
    const path = event.path;
    const params = event.queryStringParameters || {};

    if (path === "/chain/token") {
      return await getTokenInfo();
    } else if (path === "/chain/balance") {
      return await getBalance(params.address);
    } else if (path === "/chain/executed") {
      return await getExecuted(params.instructionId);
    } else if (path === "/chain/block") {
      return await getBlockNumber();
    }

    return respond(400, { error: "Unknown path. Use /chain/token, /chain/balance, /chain/executed, /chain/block" });
  } catch (err: any) {
    console.error("Chain reader error:", err);
    return respond(500, { error: err.message });
  }
}

async function getTokenInfo(): Promise<APIGatewayProxyResult> {
  const token = new Contract(TOKEN_ADDRESS, TOKEN_ABI, provider);
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    token.name(),
    token.symbol(),
    token.decimals(),
    token.totalSupply(),
  ]);
  return respond(200, {
    name,
    symbol,
    decimals: Number(decimals),
    totalSupply: formatUnits(totalSupply, decimals),
    totalSupplyRaw: totalSupply.toString(),
  });
}

async function getBalance(address?: string): Promise<APIGatewayProxyResult> {
  if (!address) return respond(400, { error: "address query param required" });
  const token = new Contract(TOKEN_ADDRESS, TOKEN_ABI, provider);
  const [balance, decimals] = await Promise.all([
    token.balanceOf(address),
    token.decimals(),
  ]);
  return respond(200, {
    address,
    balance: formatUnits(balance, decimals),
    balanceRaw: balance.toString(),
  });
}

async function getExecuted(instructionId?: string): Promise<APIGatewayProxyResult> {
  if (!instructionId) return respond(400, { error: "instructionId query param required" });
  const consumer = new Contract(SETTLEMENT_CONTRACT, CONSUMER_ABI, provider);
  const executed: boolean = await consumer.executed(instructionId);
  return respond(200, { instructionId, executed });
}

async function getBlockNumber(): Promise<APIGatewayProxyResult> {
  const blockNumber = await provider.getBlockNumber();
  return respond(200, { blockNumber });
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
