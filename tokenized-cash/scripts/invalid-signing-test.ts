#!/usr/bin/env npx ts-node
/**
 * Adversarial test of on-chain per-intent signer roles against the LIVE Besu chain.
 *
 * Uses eth_call (simulation, no state change / no gas) to submit settle(report)
 * payloads signed by the "wrong" entity key and confirms the SettlementConsumer
 * rejects them with SIGNER_INTENT_UNAUTHORIZED, while the correctly-signed
 * control passes the authorization check.
 *
 * Env: AWS_REGION, KMS_KEY_ID_CA, KMS_KEY_ID_MX, SETTLEMENT_CONTRACT, TOKEN_ADDRESS,
 *      RELAYER_ADDRESS, CA_WALLET  (and AWS creds for SSM + KMS)
 */
import { ethers } from "ethers";
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";
import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { KmsSigner } from "../lib/kmsSigner";
import { buildCsi, hashTypedData } from "../lib/csi";
import { INTENT } from "../lib/constants";

const REGION = process.env.AWS_REGION || "us-west-1";
const CHAIN_ID = 70924;
const SETTLEMENT = process.env.SETTLEMENT_CONTRACT!;
const TOKEN = process.env.TOKEN_ADDRESS!;
const RELAYER = process.env.RELAYER_ADDRESS!;
const CA_WALLET = process.env.CA_WALLET!;

const ssm = new SSMClient({ region: REGION });
const ec2 = new EC2Client({ region: REGION });

const SETTLEMENT_ABI = [
  "function settle(((" +
    "bytes32 instructionId,bytes32 messageDigest,address asset,uint256 amount," +
    "address fromParty,address toParty,uint64 valueTime,uint64 createdAt," +
    "uint64 expiry,uint8 intent,uint256 chainId,bytes32 nonce" +
  ") instruction, bytes signature) report) external",
];
const iface = new ethers.Interface(SETTLEMENT_ABI);

async function findValidatorInstance(): Promise<string> {
  if (process.env.INSTANCE_ID) return process.env.INSTANCE_ID;
  const resp = await ec2.send(new DescribeInstancesCommand({
    Filters: [
      { Name: "tag:Name", Values: ["*validator-fleet*"] },
      { Name: "instance-state-name", Values: ["running"] },
    ],
  }));
  const id = resp.Reservations?.[0]?.Instances?.[0]?.InstanceId;
  if (!id) throw new Error("No running validator instance found");
  return id;
}

async function ssmRpc(instanceId: string, payload: string): Promise<any> {
  const escaped = payload.replace(/'/g, "'\\''");
  const cmd = await ssm.send(new SendCommandCommand({
    InstanceIds: [instanceId],
    DocumentName: "AWS-RunShellScript",
    Parameters: { commands: [`curl -s -X POST http://localhost:8545 -H 'Content-Type: application/json' -d '${escaped}'`] },
  }));
  const commandId = cmd.Command!.CommandId!;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const result = await ssm.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }));
      if (result.Status === "Success") return JSON.parse(result.StandardOutputContent!);
      if (result.Status === "Failed" || result.Status === "Cancelled") throw new Error(`SSM failed: ${result.StandardErrorContent}`);
    } catch (e: any) {
      if (e.name === "InvocationDoesNotExist") continue;
      throw e;
    }
  }
  throw new Error("SSM command timed out");
}

function decodeRevert(err: any): string {
  const data: string | undefined = err?.data || err?.error?.data;
  const msg: string = err?.message || err?.error?.message || JSON.stringify(err);
  if (typeof data === "string" && data.startsWith("0x08c379a0")) {
    try {
      const reason = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10))[0];
      return `revert("${reason}")`;
    } catch { /* fall through */ }
  }
  return msg;
}

async function buildReport(signerKeyId: string, intent: number, nonceSeed: string) {
  const now = Math.floor(Date.now() / 1000);
  const nonce = ethers.keccak256(ethers.toUtf8Bytes(nonceSeed));
  const fromParty = intent === INTENT.MINT_ONLY ? "0x" + "00".repeat(20) : CA_WALLET;
  const toParty = intent === INTENT.BURN_ONLY ? "0x" + "00".repeat(20) : CA_WALLET;
  const csi = buildCsi({
    messageDigest: ethers.keccak256(ethers.toUtf8Bytes("test-" + nonceSeed)),
    asset: TOKEN,
    amount: 1000n,
    fromParty,
    toParty,
    valueTime: now,
    createdAt: now,
    expiry: now + 3600,
    intent,
    chainId: CHAIN_ID,
    nonce,
  });
  const digest = hashTypedData(csi, SETTLEMENT);
  const signer = new KmsSigner(signerKeyId, REGION);
  const sig = await signer.signDigest(digest);
  const report = {
    instruction: {
      instructionId: csi.instructionId, messageDigest: csi.messageDigest, asset: csi.asset,
      amount: csi.amount, fromParty: csi.fromParty, toParty: csi.toParty, valueTime: csi.valueTime,
      createdAt: csi.createdAt, expiry: csi.expiry, intent: csi.intent, chainId: csi.chainId, nonce: csi.nonce,
    },
    signature: sig.signature,
  };
  return { report, signerAddr: sig.signer };
}

async function ethCallSettle(instanceId: string, report: any): Promise<{ ok: boolean; reason: string }> {
  const data = iface.encodeFunctionData("settle", [report]);
  const resp = await ssmRpc(instanceId, JSON.stringify({
    jsonrpc: "2.0", method: "eth_call",
    params: [{ from: RELAYER, to: SETTLEMENT, data }, "latest"], id: 1,
  }));
  if (resp.error) return { ok: false, reason: decodeRevert(resp.error) };
  return { ok: true, reason: resp.result };
}

const CASES = [
  { name: "MX key signs MINT_ONLY", keyId: process.env.KMS_KEY_ID_MX!, intent: INTENT.MINT_ONLY, expectReject: true },
  { name: "MX key signs BURN_AND_MINT", keyId: process.env.KMS_KEY_ID_MX!, intent: INTENT.BURN_AND_MINT, expectReject: true },
  { name: "CA key signs BURN_ONLY (redeem)", keyId: process.env.KMS_KEY_ID_CA!, intent: INTENT.BURN_ONLY, expectReject: true },
  { name: "CA key signs MINT_ONLY (control)", keyId: process.env.KMS_KEY_ID_CA!, intent: INTENT.MINT_ONLY, expectReject: false },
];

async function main() {
  console.log(`Settlement: ${SETTLEMENT}`);
  const instanceId = await findValidatorInstance();
  console.log(`Validator:  ${instanceId}\n`);

  let allPass = true;
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const { report, signerAddr } = await buildReport(c.keyId, c.intent, `case-${i}-${c.name}`);
    const res = await ethCallSettle(instanceId, report);
    const rejectedForIntent = !res.ok && /SIGNER_INTENT_UNAUTHORIZED/.test(res.reason);
    let verdict: string;
    if (c.expectReject) {
      const pass = rejectedForIntent;
      allPass &&= pass;
      verdict = pass ? "PASS (rejected on-chain)" : `FAIL (expected intent rejection, got: ${res.ok ? "ACCEPTED" : res.reason})`;
    } else {
      // control: must NOT be rejected for the intent-authz reason (may pass or fail on other checks)
      const pass = !rejectedForIntent;
      allPass &&= pass;
      verdict = pass ? (res.ok ? "PASS (accepted)" : `PASS (passed authz; other check: ${res.reason})`) : "FAIL (wrongly rejected for intent)";
    }
    console.log(`[${verdict.startsWith("PASS") ? "PASS" : "FAIL"}] ${c.name}`);
    console.log(`        signer=${signerAddr} intent=${c.intent} -> ${verdict}`);
  }
  console.log(`\n${allPass ? "ALL ROLE-ENFORCEMENT CHECKS PASSED" : "SOME CHECKS FAILED"}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(2); });
