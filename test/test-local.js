#!/usr/bin/env node
import "dotenv/config";

/**
 * Test script for x402-extract-api
 * 
 * Usage:
 *   node test/test-local.js          # Test 402 response (no payment)
 *   node test/test-local.js --extract # Test extraction directly (bypasses x402)
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:4021";
const mode = process.argv[2];

async function test402Response() {
  console.log("\n=== Testing 402 Payment Required Response ===\n");

  const url = `${BASE_URL}/extract?url=https://example.com&intent=company_info`;
  console.log(`GET ${url}\n`);

  const res = await fetch(url);
  console.log(`Status: ${res.status} ${res.statusText}`);
  console.log(`\nHeaders:`);
  for (const [key, value] of res.headers) {
    if (key.toLowerCase().includes("payment") || key.toLowerCase().includes("x402")) {
      console.log(`  ${key}: ${value.slice(0, 120)}...`);
    }
  }

  const body = await res.text();
  try {
    const json = JSON.parse(body);
    console.log(`\nResponse body (parsed):`);
    console.log(JSON.stringify(json, null, 2).slice(0, 500));
  } catch {
    console.log(`\nResponse body (first 300 chars):`);
    console.log(body.slice(0, 300));
  }

  if (res.status === 402) {
    console.log("\n✅ 402 response received — x402 middleware is working!");
    console.log("   An agent with a wallet would now pay and retry.");
  } else if (res.status === 200) {
    console.log("\n⚠️  Got 200 — payment middleware may not be active.");
  } else {
    console.log(`\n❌ Unexpected status: ${res.status}`);
  }
}

async function testHealthCheck() {
  console.log("\n=== Testing Health Check ===\n");

  const res = await fetch(`${BASE_URL}/health`);
  const data = await res.json();
  console.log(`Status: ${res.status}`);
  console.log(JSON.stringify(data, null, 2));
  console.log(res.status === 200 ? "\n✅ Health check passed" : "\n❌ Health check failed");
}

async function testExtractDirect() {
  console.log("\n=== Testing Extraction Directly (bypassing x402) ===\n");
  console.log("This imports the extract function directly to test Claude integration.\n");

  // Dynamic import
  const { extract } = await import("../src/extract.js");

  const testCases = [
    { url: "https://anthropic.com", intent: "company_info" },
    { url: "https://railway.app/pricing", intent: "pricing" },
  ];

  for (const tc of testCases) {
    console.log(`\n--- Extracting: ${tc.intent} from ${tc.url} ---`);
    try {
      const result = await extract(tc.url, tc.intent);
      console.log(JSON.stringify(result, null, 2));
      console.log("✅ Extraction succeeded");
    } catch (err) {
      console.log(`❌ Extraction failed: ${err.message}`);
    }
  }
}

async function main() {
  try {
    if (mode === "--extract") {
      await testExtractDirect();
    } else {
      await testHealthCheck();
      await test402Response();
    }
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    if (err.cause?.code === "ECONNREFUSED") {
      console.error("Is the server running? Try: npm run dev");
    }
    process.exit(1);
  }
}

main();
