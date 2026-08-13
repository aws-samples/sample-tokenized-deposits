#!/usr/bin/env npx ts-node
/**
 * Generates the deployer keypair and derives the relayer address from KMS.
 *
 * - Deployer: a random Ethereum key used once to deploy contracts, then discarded
 * - Relayer: a KMS key (created by CDK) — this script derives its Ethereum address
 *
 * Both addresses must be prefunded in the Besu genesis (run setup-besu-genesis.sh after).
 *
 * Prerequisites: Deploy the CDK stack first (step 4) to create the KMS keys, then
 * run this script to get addresses for genesis patching, then deploy Besu, then
 * deploy contracts.
 *
 * Usage:
 *   KMS_KEY_ID_RELAYER=<relayer-key-id> npx ts-node scripts/generate-deployer-relayer.ts
 */
import { ethers } from "ethers";
import { KmsSigner } from "../lib/kmsSigner";

const REGION = process.env.AWS_REGION || "us-west-2";

async function main() {
  const kmsKeyIdRelayer = process.env.KMS_KEY_ID_RELAYER;
  if (!kmsKeyIdRelayer) {
    console.error("Required: KMS_KEY_ID_RELAYER (from CDK output 'RelayerKmsKeyId')");
    console.error("Run 'npx cdk deploy' first to create KMS keys, then re-run this script.");
    process.exit(1);
  }

  console.log("=== Generating Deployer Key + Deriving Relayer Address ===\n");

  // Generate deployer (ephemeral — only used for contract deployment)
  const deployer = ethers.Wallet.createRandom();
  console.log("Deployer (one-time use for contract deployment):");
  console.log(`  Address:     ${deployer.address}`);
  console.log(`  Private Key: ${deployer.privateKey}`);
  console.log("");

  // Derive relayer address from KMS key
  const relayerSigner = new KmsSigner(kmsKeyIdRelayer, REGION);
  const relayerAddress = await relayerSigner.getAddress();
  console.log("Relayer (KMS-backed, signs settle() transactions):");
  console.log(`  KMS Key ID:  ${kmsKeyIdRelayer}`);
  console.log(`  Address:     ${relayerAddress}`);
  console.log("");

  console.log("=== Next Steps ===");
  console.log("");
  console.log("1. Prefund both addresses in genesis:");
  console.log(`   DEPLOYER_ADDRESS=${deployer.address} RELAYER_ADDRESS=${relayerAddress} ./scripts/setup-besu-genesis.sh`);
  console.log("");
  console.log("2. Save deployer key for contract deployment (step 3b):");
  console.log(`   export DEPLOYER_KEY=${deployer.privateKey}`);
  console.log("");
  console.log("NOTE: The deployer key is ephemeral — discard after contracts are deployed.");
  console.log("The relayer key lives permanently in KMS (never leaves the HSM).");
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
