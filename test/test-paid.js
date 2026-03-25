#!/usr/bin/env node
import "dotenv/config";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Test the full x402 payment flow against a live server.
 *
 * Prerequisites:
 *   1. Set EVM_PRIVATE_KEY in .env (a Base Sepolia wallet private key)
 *   2. Fund that wallet with testnet USDC from https://faucet.circle.com/
 *   3. Fund with Base Sepolia ETH for gas from https://portal.cdp.coinbase.com/products/faucet
 *
 * Usage:
 *   node test/test-paid.js                           # hits production
 *   node test/test-paid.js http://localhost:4021      # hits local
 */

const BASE_URL = process.argv[2] || "https://x402-extract-api-production.up.railway.app";
const PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error("Set EVM_PRIVATE_KEY in .env (Base Sepolia wallet with testnet USDC)");
  console.error("\nTo set up:");
  console.error("  1. Generate a key: node -e \"import('viem/accounts').then(m => console.log(m.generatePrivateKey()))\"");
  console.error("  2. Add to .env: EVM_PRIVATE_KEY=0x...");
  console.error("  3. Get testnet USDC: https://faucet.circle.com/ (select Base Sepolia)");
  console.error("  4. Get testnet ETH: https://portal.cdp.coinbase.com/products/faucet");
  process.exit(1);
}

const signer = privateKeyToAccount(PRIVATE_KEY);
const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(signer));
const paidFetch = wrapFetchWithPayment(fetch, client);

console.log(`\nWallet: ${signer.address}`);
console.log(`Server: ${BASE_URL}\n`);

async function testAmazonSkincare() {
  console.log("=== POST /extract (Amazon skincare top 20, custom schema, $0.05) ===\n");

  const res = await paidFetch(`${BASE_URL}/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://www.amazon.com/s?k=skincare",
      intent: "custom",
      schema: {
        products: [{
          rank: "number",
          name: "string",
          brand: "string",
          price: "string",
          rating: "number",
          review_count: "number",
          is_sponsored: "boolean",
        }],
      },
    }),
  });

  const text = await res.text();
  console.log(`Status: ${res.status}`);
  try {
    const data = JSON.parse(text);
    console.log(JSON.stringify(data, null, 2));
    if (data.data?.products) {
      console.log(`\nExtracted ${data.data.products.length} products`);
    }
  } catch {
    console.log(`Raw response: ${text}`);
  }
  console.log(res.status === 200 ? "\n✅ Amazon extraction succeeded\n" : "\n❌ Failed\n");
}

async function main() {
  try {
    await testAmazonSkincare();
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
}

main();
