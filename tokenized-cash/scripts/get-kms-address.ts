#!/usr/bin/env npx ts-node
/**
 * Derives the Ethereum address from a KMS secp256k1 key.
 * Usage: KMS_KEY_ID=alias/tokenized-cash/csi-signer npx ts-node scripts/get-kms-address.ts
 */
import { KmsSigner } from "../lib/kmsSigner";

async function main() {
  const keyId = process.env.KMS_KEY_ID;
  if (!keyId) {
    console.error("Set KMS_KEY_ID environment variable");
    process.exit(1);
  }

  const signer = new KmsSigner(keyId, process.env.AWS_REGION);
  const address = await signer.getAddress();
  console.log(`KMS Key:     ${keyId}`);
  console.log(`ETH Address: ${address}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
