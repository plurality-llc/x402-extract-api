#!/usr/bin/env node
import "dotenv/config";
import { createPaidFetch } from "../src/x402-client.js";
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
const paidFetch = createPaidFetch(PRIVATE_KEY);

console.log(`\nWallet: ${signer.address}`);
console.log(`Server: ${BASE_URL}\n`);

async function testGetExtract() {
  console.log("=== GET /extract (Anthropic company_info, $0.03) ===\n");

  const res = await paidFetch(
    `${BASE_URL}/extract?url=${encodeURIComponent("https://anthropic.com")}&intent=company_info`
  );

  const text = await res.text();
  console.log(`Status: ${res.status}`);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(`Raw response: ${text}`);
  }
  console.log(res.status === 200 ? "\n✅ GET extraction succeeded\n" : "\n❌ Failed\n");
}

async function testPostExtract() {
  console.log("=== POST /extract (Reddit r/technology, custom schema, $0.05) ===\n");

  const res = await paidFetch(`${BASE_URL}/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://www.reddit.com/r/technology",
      intent: "custom",
      schema: {
        posts: [{
          title: "string",
          author: "string",
          score: "number",
          comment_count: "number",
        }],
      },
    }),
  });

  const text = await res.text();
  console.log(`Status: ${res.status}`);
  try {
    const data = JSON.parse(text);
    console.log(JSON.stringify(data, null, 2));
    if (data.data?.posts) {
      console.log(`\nExtracted ${data.data.posts.length} posts`);
    }
  } catch {
    console.log(`Raw response: ${text}`);
  }
  console.log(res.status === 200 ? "\n✅ POST extraction succeeded\n" : "\n❌ Failed\n");
}

async function main() {
  try {
    await testGetExtract();
    await testPostExtract();
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
}

main();
