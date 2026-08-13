#!/usr/bin/env npx ts-node
/**
 * Deploy contracts to Besu by signing transactions locally and broadcasting
 * via SSM RunShellScript on a validator instance (since the NLB is internal).
 *
 * Required env vars:
 *   AWS_REGION          - AWS region (default: us-west-2)
 *   DEPLOYER_KEY        - Private key for deployer EOA (prefunded in genesis)
 *   KMS_KEY_ID_CA       - KMS key ID for CA entity signer (signs mints)
 *   KMS_KEY_ID_MX       - KMS key ID for MX entity signer (signs redeems/burns)
 *   KMS_KEY_ID_RELAYER  - KMS key ID for relayer signer (signs settle txs)
 *   INSTANCE_ID         - (optional) SSM-managed validator instance ID
 *
 * Usage:
 *   DEPLOYER_KEY=0x... KMS_KEY_ID_CA=... KMS_KEY_ID_MX=... KMS_KEY_ID_RELAYER=... npx ts-node scripts/deploy-contracts-via-ssm.ts
 */
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { KmsSigner } from "../lib/kmsSigner";
import {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand,
} from "@aws-sdk/client-ssm";
import {
  EC2Client,
  DescribeInstancesCommand,
} from "@aws-sdk/client-ec2";

const CHAIN_ID = 70924;
const REGION = process.env.AWS_REGION || "us-west-2";

const ssm = new SSMClient({ region: REGION });
const ec2 = new EC2Client({ region: REGION });

async function findValidatorInstance(): Promise<string> {
  if (process.env.INSTANCE_ID) return process.env.INSTANCE_ID;

  const resp = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:Name", Values: ["*validator-fleet*"] },
        { Name: "instance-state-name", Values: ["running"] },
      ],
    })
  );
  const id = resp.Reservations?.[0]?.Instances?.[0]?.InstanceId;
  if (!id) throw new Error("No running validator instance found");
  return id;
}

async function ssmRpc(instanceId: string, rpcPayload: string): Promise<any> {
  const escaped = rpcPayload.replace(/'/g, "'\\''");
  const cmd = await ssm.send(
    new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: "AWS-RunShellScript",
      Parameters: {
        commands: [
          `curl -s -X POST http://localhost:8545 -H 'Content-Type: application/json' -d '${escaped}'`,
        ],
      },
    })
  );
  const commandId = cmd.Command!.CommandId!;

  // Poll for result
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const result = await ssm.send(
        new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: instanceId,
        })
      );
      if (result.Status === "Success") {
        return JSON.parse(result.StandardOutputContent!);
      }
      if (result.Status === "Failed" || result.Status === "Cancelled") {
        throw new Error(`SSM command failed: ${result.StandardErrorContent}`);
      }
    } catch (e: any) {
      if (e.name === "InvocationDoesNotExist") continue;
      throw e;
    }
  }
  throw new Error("SSM command timed out");
}

async function sendRawTx(instanceId: string, signedTx: string): Promise<string> {
  const resp = await ssmRpc(
    instanceId,
    JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_sendRawTransaction",
      params: [signedTx],
      id: 1,
    })
  );
  if (resp.error) throw new Error(`RPC error: ${resp.error.message}`);
  return resp.result;
}

async function waitForReceipt(instanceId: string, txHash: string): Promise<any> {
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const resp = await ssmRpc(
      instanceId,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_getTransactionReceipt",
        params: [txHash],
        id: 1,
      })
    );
    if (resp.result && resp.result.status) {
      return resp.result;
    }
  }
  throw new Error(`Timeout waiting for receipt: ${txHash}`);
}

async function main() {
  const deployerKey = process.env.DEPLOYER_KEY;
  const kmsKeyIdCa = process.env.KMS_KEY_ID_CA;
  const kmsKeyIdMx = process.env.KMS_KEY_ID_MX;
  const kmsKeyIdRelayer = process.env.KMS_KEY_ID_RELAYER;

  if (!deployerKey || !kmsKeyIdCa || !kmsKeyIdMx || !kmsKeyIdRelayer) {
    console.error("Required env vars: DEPLOYER_KEY, KMS_KEY_ID_CA, KMS_KEY_ID_MX, KMS_KEY_ID_RELAYER");
    process.exit(1);
  }

  // Derive KMS signer addresses
  console.log("Deriving KMS signer addresses...");
  const caKmsSigner = new KmsSigner(kmsKeyIdCa, REGION);
  const caSignerAddress = await caKmsSigner.getAddress();
  const mxKmsSigner = new KmsSigner(kmsKeyIdMx, REGION);
  const mxSignerAddress = await mxKmsSigner.getAddress();
  const relayerKmsSigner = new KmsSigner(kmsKeyIdRelayer, REGION);
  const relayerAddress = await relayerKmsSigner.getAddress();
  console.log(`  CA Signer:  ${caSignerAddress}`);
  console.log(`  MX Signer:  ${mxSignerAddress}`);
  console.log(`  Relayer:    ${relayerAddress}`);

  // Load compiled artifacts
  const contractsDir = path.join(__dirname, "../contracts/out");
  if (!fs.existsSync(contractsDir)) {
    console.error(
      "Compiled artifacts not found. Run first:\n" +
        "  cd contracts && forge build --via-ir --optimizer-runs 200"
    );
    process.exit(1);
  }

  const registryArtifact = JSON.parse(
    fs.readFileSync(path.join(contractsDir, "KeyRegistry.sol/KeyRegistry.json"), "utf8")
  );
  const consumerArtifact = JSON.parse(
    fs.readFileSync(path.join(contractsDir, "SettlementConsumer.sol/SettlementConsumer.json"), "utf8")
  );
  const tokenArtifact = JSON.parse(
    fs.readFileSync(path.join(contractsDir, "Token.sol/Token.json"), "utf8")
  );

  const wallet = new ethers.Wallet(deployerKey);
  console.log(`  Deployer:   ${wallet.address}`);

  // Find validator instance
  console.log("\nFinding validator instance...");
  const instanceId = await findValidatorInstance();
  console.log(`  Instance:   ${instanceId}`);

  // Get current nonce
  const nonceResp = await ssmRpc(
    instanceId,
    JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_getTransactionCount",
      params: [wallet.address, "latest"],
      id: 1,
    })
  );
  const startNonce = parseInt(nonceResp.result, 16);
  console.log(`  Nonce:      ${startNonce}`);

  // Compute CREATE addresses (nonce+1 is addSigner call, not a deploy)
  const registryAddr = ethers.getCreateAddress({ from: wallet.address, nonce: startNonce });
  // nonce+1 = addSigner(mxSignerAddress) call on registry
  const consumerAddr = ethers.getCreateAddress({ from: wallet.address, nonce: startNonce + 2 });
  const tokenAddr = ethers.getCreateAddress({ from: wallet.address, nonce: startNonce + 3 });

  console.log("\nPredicted addresses:");
  console.log(`  KeyRegistry:          ${registryAddr}`);
  console.log(`  SettlementConsumer:   ${consumerAddr}`);
  console.log(`  Token (tCAD):         ${tokenAddr}`);

  // Build deploy data (KeyRegistry constructor takes admin + initial signer)
  const iRegistry = new ethers.Interface(registryArtifact.abi);
  const registryData =
    registryArtifact.bytecode.object +
    iRegistry.encodeDeploy([wallet.address, caSignerAddress]).slice(2);

  // addSigner(mxSignerAddress) call data
  const addSignerData = iRegistry.encodeFunctionData("addSigner", [mxSignerAddress]);

  const iConsumer = new ethers.Interface(consumerArtifact.abi);
  const consumerData =
    consumerArtifact.bytecode.object +
    iConsumer.encodeDeploy([registryAddr, relayerAddress]).slice(2);

  const iToken = new ethers.Interface(tokenArtifact.abi);
  const tokenData =
    tokenArtifact.bytecode.object +
    iToken.encodeDeploy(["Tokenized CAD", "tCAD", consumerAddr]).slice(2);

  // Sign transactions (legacy type 0, gasPrice 0 for private chain)
  async function signTx(data: string, nonce: number, gasLimit: number, to?: string) {
    return wallet.signTransaction({
      type: 0,
      chainId: CHAIN_ID,
      nonce,
      to: to ?? null,
      value: 0,
      data,
      gasPrice: 0,
      gasLimit,
    });
  }

  const signedRegistry = await signTx(registryData, startNonce, 5_000_000);
  const signedAddSigner = await signTx(addSignerData, startNonce + 1, 500_000, registryAddr);
  const signedConsumer = await signTx(consumerData, startNonce + 2, 10_000_000);
  const signedToken = await signTx(tokenData, startNonce + 3, 5_000_000);

  // Deploy sequentially
  console.log("\nDeploying KeyRegistry...");
  const txHash1 = await sendRawTx(instanceId, signedRegistry);
  const receipt1 = await waitForReceipt(instanceId, txHash1);
  if (receipt1.status !== "0x1") throw new Error(`KeyRegistry deploy reverted: ${txHash1}`);
  console.log(`  OK: ${receipt1.contractAddress} (gas: ${parseInt(receipt1.gasUsed, 16)})`);

  console.log("Registering MX signer in KeyRegistry...");
  const txHash1b = await sendRawTx(instanceId, signedAddSigner);
  const receipt1b = await waitForReceipt(instanceId, txHash1b);
  if (receipt1b.status !== "0x1") throw new Error(`addSigner reverted: ${txHash1b}`);
  console.log(`  OK: MX signer ${mxSignerAddress} registered`);

  console.log("Deploying SettlementConsumer...");
  const txHash2 = await sendRawTx(instanceId, signedConsumer);
  const receipt2 = await waitForReceipt(instanceId, txHash2);
  if (receipt2.status !== "0x1") throw new Error(`SettlementConsumer deploy reverted: ${txHash2}`);
  console.log(`  OK: ${receipt2.contractAddress} (gas: ${parseInt(receipt2.gasUsed, 16)})`);

  console.log("Deploying Token (tCAD)...");
  const txHash3 = await sendRawTx(instanceId, signedToken);
  const receipt3 = await waitForReceipt(instanceId, txHash3);
  if (receipt3.status !== "0x1") throw new Error(`Token deploy reverted: ${txHash3}`);
  console.log(`  OK: ${receipt3.contractAddress} (gas: ${parseInt(receipt3.gasUsed, 16)})`);

  console.log("\n=== Deployment Complete ===");
  console.log(`KeyRegistry:        ${receipt1.contractAddress}`);
  console.log(`  CA Signer:        ${caSignerAddress}`);
  console.log(`  MX Signer:        ${mxSignerAddress}`);
  console.log(`SettlementConsumer: ${receipt2.contractAddress}`);
  console.log(`Token (tCAD):       ${receipt3.contractAddress}`);
  console.log("\nNext step — deploy the application stack:");
  console.log(`  npx cdk deploy \\`);
  console.log(`    -c settlementContract=${receipt2.contractAddress} \\`);
  console.log(`    -c tokenAddress=${receipt3.contractAddress} \\`);
  console.log(`    -c besuVpcId=<vpc-id> \\`);
  console.log(`    -c besuRpcUrl=http://<nlb-dns>:80`);
}

main().catch((err) => {
  console.error("\nDEPLOY FAILED:", err.message);
  process.exit(1);
});
