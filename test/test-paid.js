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

async function testRedditFrontPage() {
  console.log("=== POST /extract (Reddit front page, custom schema, $0.15) ===\n");

  const res = await paidFetch(`${BASE_URL}/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://www.reddit.com/r/technology",
      intent: "custom",
      schema: {
        subreddit_posts: [{
          title: "string",
          subreddit: "string",
          author: "string",
          score: "number",
          comment_count: "number",
          url: "string",
        }],
      },
    }),
  });

  const text = await res.text();
  console.log(`Status: ${res.status}`);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(`Raw response: ${text}`);
  }
  console.log(res.status === 200 ? "\n✅ Reddit extraction succeeded\n" : "\n❌ Failed\n");
}

async function main() {
  try {
    await testRedditFrontPage();
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
}

main();
