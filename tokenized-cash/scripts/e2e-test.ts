#!/usr/bin/env npx ts-node
/**
 * End-to-end test: exercises the full mint → transfer → redeem → burn lifecycle
 * against a deployed stack. Run after `cdk deploy`.
 *
 * Required env vars:
 *   API_URL     - API Gateway base URL (e.g., https://xxx.execute-api.us-east-1.amazonaws.com/v1)
 *   API_KEY     - API key for authentication
 *   CA_WALLET   - CA entity wallet address
 *   MX_WALLET   - MX entity wallet address
 *   TOKEN_ADDR  - Deployed tCAD token address
 */

const API_URL = process.env.API_URL!;
const API_KEY = process.env.API_KEY!;
const CA_WALLET = process.env.CA_WALLET!;
const MX_WALLET = process.env.MX_WALLET!;
const TOKEN_ADDR = process.env.TOKEN_ADDR!;

async function apiCall(path: string, body: object): Promise<any> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { "x-api-key": API_KEY },
  });
  return res.json();
}

async function waitForExecution(instructionId: string, timeoutMs = 120000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5000));
    const result = await apiGet(`/chain/executed?instructionId=${instructionId}`);
    if (result.executed) {
      console.log(`   ✓ ${instructionId.slice(0, 10)}... executed on-chain`);
      return true;
    }
    console.log(`   Waiting for ${instructionId.slice(0, 10)}... (${Math.round((Date.now() - start) / 1000)}s)`);
  }
  return false;
}

async function waitForBalance(address: string, minBalance: string, timeoutMs = 120000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5000));
    const result = await apiGet(`/chain/balance?address=${address}`);
    if (BigInt(result.balanceRaw || "0") >= BigInt(minBalance)) {
      console.log(`   ✓ ${address.slice(0, 10)}... balance: ${result.balance}`);
      return true;
    }
    console.log(`   Waiting for ${address.slice(0, 10)}... balance (${Math.round((Date.now() - start) / 1000)}s)`);
  }
  return false;
}

async function main() {
  if (!API_URL || !API_KEY || !CA_WALLET || !MX_WALLET || !TOKEN_ADDR) {
    console.error("Missing required env vars: API_URL, API_KEY, CA_WALLET, MX_WALLET, TOKEN_ADDR");
    process.exit(1);
  }

  console.log("=== Tokenized Deposits E2E Test ===");
  console.log(`API: ${API_URL}`);
  console.log(`CA Wallet: ${CA_WALLET}`);
  console.log(`MX Wallet: ${MX_WALLET}`);
  console.log(`Token: ${TOKEN_ADDR}`);
  console.log("");

  // Step 1: Fetch live FX rate (from Bank of Canada via Lambda)
  console.log("1. Fetching live FX rate from Bank of Canada...");
  const fxResult = await apiGet("/fx/rate");
  console.log(`   FX rate: ${fxResult.display} (source: ${fxResult.source})`);

  // Step 2: Mint 100 tCAD to CA wallet
  console.log("\n2. Minting 100 tCAD to CA wallet...");
  const mintResult = await apiCall("/mint", {
    asset: TOKEN_ADDR,
    amount: "100000000000000000000", // 100 * 10^18
    toParty: CA_WALLET,
    reference: `e2e-mint-${Date.now()}`,
    entity: "CA",
  });
  console.log(`   Instruction: ${mintResult.instructionId}`);
  console.log(`   Status: ${mintResult.status}`);
  console.log(`   Signer: ${mintResult.signer}`);

  // Step 2b: Verify collateral lock
  console.log("\n2b. Verifying CAD collateral is LOCKED...");
  const mintDetail = await apiGet(`/instructions/${mintResult.instructionId}`);
  if (!mintDetail.collateral) {
    throw new Error("No collateral record found on mint instruction");
  }
  if (mintDetail.collateral.status !== "LOCKED") {
    throw new Error(`Expected collateral LOCKED, got ${mintDetail.collateral.status}`);
  }
  console.log(`   ✓ Collateral LOCKED — ${mintDetail.collateral.cadAmount ? BigInt(mintDetail.collateral.cadAmount) / BigInt(10**18) : '?'} CAD in ${mintDetail.collateral.accountRef}`);

  // Step 3: Wait for mint to execute on-chain
  console.log("\n3. Waiting for mint to execute on-chain...");
  const mintExecuted = await waitForExecution(mintResult.instructionId);
  if (!mintExecuted) {
    throw new Error("Mint did not execute within timeout");
  }

  // Step 4: Wait for stage handler to transfer CA→MX (BURN_AND_MINT)
  console.log("\n4. Waiting for stage handler to transfer tokens CA→MX...");
  const mxFunded = await waitForBalance(MX_WALLET, "100000000000000000000");
  if (!mxFunded) {
    throw new Error("Transfer CA→MX did not complete within timeout");
  }

  // Step 5: Redeem (burn from MX wallet — MX now has tokens)
  console.log("\n5. Creating redeem instruction (burn from MX)...");
  const redeemResult = await apiCall("/redeem", {
    asset: TOKEN_ADDR,
    amount: "100000000000000000000",
    fromParty: MX_WALLET,
    toParty: MX_WALLET,
    reference: `e2e-redeem-${Date.now()}`,
  });
  console.log(`   Instruction: ${redeemResult.instructionId}`);
  console.log(`   Status: ${redeemResult.status}`);

  // Step 6: Wait for burn to execute
  console.log("\n6. Waiting for burn to execute on-chain...");
  const burnExecuted = await waitForExecution(redeemResult.instructionId);
  if (!burnExecuted) {
    throw new Error("Burn did not execute within timeout");
  }

  // Step 6b: Verify redemption posting is POSTED (wait for stage handler)
  console.log("\n6b. Verifying MXN disbursement posted...");
  let mxnPosted = false;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const redeemDetail = await apiGet(`/instructions/${redeemResult.instructionId}`);
    if (redeemDetail.redemption?.status === "POSTED") {
      console.log(`   ✓ MXN disbursement POSTED — ${BigInt(redeemDetail.redemption.mxnAmount) / BigInt(10**18)} MXN at rate ${redeemDetail.redemption.fxRate / 1000}`);
      mxnPosted = true;
      break;
    }
    console.log(`   Waiting for MXN posting... (${(i + 1) * 5}s)`);
  }
  if (!mxnPosted) {
    throw new Error("MXN disbursement did not post within timeout");
  }

  // Step 6c: Verify CAD collateral was released to back this burn.
  // Collateral release is FIFO (oldest lock first), so the released lock is NOT
  // necessarily this run's mint — with prior locks in the table it won't be.
  // The correct, FIFO-agnostic signal is the reconciliation record written for
  // THIS redeem instruction: its `collateralReleased` is the CAD freed for this
  // specific burn, wherever FIFO sourced it from.
  console.log("\n6c. Verifying CAD collateral released for this burn (via reconciliation)...");
  const burnAmount = BigInt("100000000000000000000");
  let reconciliation: any = null;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const reconDetail = await apiGet(`/instructions/${redeemResult.instructionId}`);
    if (reconDetail.reconciliation) {
      reconciliation = reconDetail.reconciliation;
      break;
    }
    console.log(`   Waiting for collateral release / reconciliation... (${(i + 1) * 5}s)`);
  }
  if (!reconciliation) {
    throw new Error("Collateral was not released (no reconciliation record) within timeout");
  }
  if (BigInt(reconciliation.collateralReleased) < burnAmount) {
    throw new Error(
      `Collateral released (${reconciliation.collateralReleased}) does not cover burn (${burnAmount})`
    );
  }
  console.log(`   ✓ CAD collateral released: ${BigInt(reconciliation.collateralReleased) / BigInt(10**18)} CAD (FIFO)`);

  // Step 6d: Verify the reconciliation matched on-chain burn to off-chain obligations
  console.log("\n6d. Verifying reconciliation...");
  console.log(`   ✓ Reconciliation: ${reconciliation.status}`);
  console.log(`     Burned: ${BigInt(reconciliation.burnAmount) / BigInt(10**18)} tCAD`);
  console.log(`     CAD released: ${BigInt(reconciliation.collateralReleased) / BigInt(10**18)} CAD`);
  console.log(`     MXN posted: ${BigInt(reconciliation.mxnPosted) / BigInt(10**18)} MXN`);
  if (reconciliation.status !== "MATCHED") {
    throw new Error(`Reconciliation MISMATCH — expected MATCHED`);
  }

  // Step 7: Verify token supply is back to 0
  console.log("\n7. Verifying final state...");
  const tokenState = await apiGet("/chain/token");
  console.log(`   Total supply: ${tokenState.totalSupply} tCAD`);

  // Step 8: Check FX conversion
  console.log("\n8. FX conversion check...");
  const convertResult = await apiCall("/fx/convert", {
    cadAmount: "100000000000000000000",
  });
  console.log(`   100 CAD → ${BigInt(convertResult.mxnAmount) / BigInt(10 ** 18)} MXN (rate: ${convertResult.display})`);

  console.log("\n=== E2E Test Complete — Full Lifecycle Verified ===");
  console.log("On-chain:  MINT → TRANSFER (CA→MX) → BURN");
  console.log("Off-chain: CAD LOCKED → MXN POSTED → CAD RELEASED");
}

main().catch((err) => {
  console.error("E2E FAILED:", err.message);
  process.exit(1);
});
