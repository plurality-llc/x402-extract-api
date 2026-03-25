# x402 Extract API

A paid, agent-discoverable API for structured web intelligence extraction. Built on the x402 protocol — agents discover it on the Bazaar, pay per request in USDC, and get clean structured JSON back.

**Endpoints:**

| Route | Price | Description |
|-------|-------|-------------|
| `GET /extract` | $0.02 | Extract structured data from any URL based on intent |
| `POST /valuate` | $0.05 | Get resale value estimates for products (Phase 2) |
| `GET /health` | free | Health check (not gated) |

## Prerequisites

1. **Node.js 20+** (required for Ed25519 JWT signing used by CDP facilitator)
2. **A wallet on Base** — any EVM wallet works. You'll receive USDC here.
3. **Coinbase Developer Platform (CDP) account** — free at https://portal.cdp.coinbase.com
   - Create an API key (you'll get a key ID and secret)
4. **Anthropic API key** — for the Claude extraction layer
5. **USDC on Base Sepolia** (for testnet) — get from https://faucet.circle.com

## Quick Start

```bash
# Clone and install
git clone <your-repo>
cd x402-extract-api
npm install

# Configure
cp .env.example .env
# Edit .env with your keys

# Run locally (testnet)
npm run dev

# Test the 402 flow
curl http://localhost:4021/extract?url=https://example.com&intent=company_info
# → Returns 402 with payment instructions

# Deploy to Railway
railway init
railway up
```

## Environment Variables

```
# Your wallet address on Base (receives USDC payments)
PAY_TO_ADDRESS=0xYourWalletAddress

# CDP API keys (from portal.cdp.coinbase.com)
CDP_API_KEY_ID=your-key-id
CDP_API_KEY_SECRET=your-key-secret

# Anthropic API key (for Claude extraction)
ANTHROPIC_API_KEY=sk-ant-...

# Network: "base-sepolia" for testnet, "base" for mainnet
NETWORK=base-sepolia

# Port
PORT=4021
```

## Architecture

```
Agent request
  → x402 middleware checks for payment
  → If no payment: returns 402 + payment instructions + Bazaar metadata
  → If paid: 
    → Fetch URL content (cheerio)
    → Send to Claude with intent-specific extraction prompt
    → Return structured JSON
```

## Extraction Intents

| Intent | Returns |
|--------|---------|
| `product_specs` | Name, brand, price, specs, images, availability |
| `company_info` | Name, description, industry, founding, team, contact |
| `article_summary` | Title, author, date, summary, key points, entities |
| `pricing` | Plans, tiers, features, prices, billing options |
| `job_listing` | Title, company, location, salary, requirements, benefits |
| `reviews` | Aggregated rating, review count, pros, cons, themes |

## Bazaar Discovery

This API is automatically listed on the x402 Bazaar after the first successful payment through the CDP facilitator. Agents can discover it by querying:

```
GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources
```

## Roadmap

- [x] Phase 1: Web extraction API (`/extract`)
- [ ] Phase 2: Product valuation API (`/valuate`) — connects to home inventory app
- [ ] Phase 3: Vietnam market intelligence endpoints
- [ ] MCP server wrapper for Claude/Cursor integration
