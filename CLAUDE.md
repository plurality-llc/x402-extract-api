# CLAUDE.md — x402 Extract API

## Code Style Principles

**Balance cleanliness with completeness.** Code should be:

### Clean (Opus-style)
- **Concise**: No unnecessary abstractions or helper functions for one-time operations
- **Readable**: Self-explanatory code over excessive comments
- **Minimal**: Only include what's needed for the feature
- **Consistent**: Follow existing patterns in the codebase

### Complete (Production-ready)
- **All wireframe elements present**: Don't skip UI features
- **All database fields used**: Types should reflect full schema
- **All edge cases handled**: Loading, error, empty states
- **All validations in place**: Prevent invalid data states

### The Rule
> Write the **minimum code** needed to be **fully complete**.
> If a feature isn't in the wireframe, don't add it.
> If a feature IS in the wireframe, don't skip it.


## Project overview

A paid API that extracts structured intelligence from web pages, gated by the x402 payment protocol. AI agents discover this service on the x402 Bazaar, pay $0.02 per call in USDC on Base, and receive clean structured JSON.

**Owner:** Michael / Plurality LLC
**Stack:** Node.js 20+ / Express 4 / x402 v2 SDK / Anthropic Claude API / Cheerio
**Deploy target:** Railway
**Payment:** USDC on Base via x402 protocol (testnet: Base Sepolia)

## Architecture

```
Request → x402 middleware (checks payment) → Express route → fetchPageContent (cheerio) → Claude extraction → structured JSON response
```

- `src/server.js` — Express app, x402 middleware config, route definitions, Bazaar discovery metadata
- `src/extract.js` — Page fetching (cheerio), Claude prompt dispatch, JSON parsing
- `test/test-local.js` — Local testing script (402 flow + direct extraction)

## Key decisions

- **Express 4, not 5.** The x402 middleware has known issues with Express 5 route matching. Stay on 4.
- **@x402/express v2 SDK.** Uses the modular package structure (@x402/core, @x402/evm, @x402/extensions) not the legacy x402-express package.
- **Bazaar discovery enabled.** Routes include `declareDiscoveryExtension()` so the API auto-lists on the Bazaar after the first successful payment.
- **Model routing by intent.** Haiku 4.5 for structured extraction (product_specs, company_info, pricing, job_listing), Sonnet for analytical intents (article_summary, reviews). Haiku costs ~$0.004/call vs Sonnet's ~$0.012. Most traffic should hit Haiku. The `_meta` field in responses includes model used + token counts for cost monitoring.
- **Claude Sonnet for complex intents only.** article_summary and reviews need summarization and sentiment judgment. Everything else is schema-filling that Haiku handles fine. If an intent seems borderline, test it on Haiku first — only promote to Sonnet if quality drops noticeably.
- **Cheerio for HTML parsing.** No headless browser needed — keeps the container light and fast. Won't work for SPAs that require JS rendering; that's a known limitation to document.

## Environment variables

Required:
- `PAY_TO_ADDRESS` — Base wallet address receiving USDC
- `ANTHROPIC_API_KEY` — Claude API key
- `NETWORK` — "base-sepolia" (testnet) or "base" (mainnet)

Optional (mainnet only):
- `CDP_API_KEY_ID` — Coinbase Developer Platform key ID
- `CDP_API_KEY_SECRET` — CDP key secret

## Development workflow

```bash
npm run dev          # Start with --watch
node test/test-local.js         # Test 402 response
node test/test-local.js --extract  # Test extraction directly
```

## Guardrails

- Never install Express 5 — breaks x402 middleware
- Always return valid JSON from /extract — agents depend on consistent schema
- Keep extraction prompts in INTENT_PROMPTS object in extract.js — single source of truth
- Price is $0.02/call — Haiku intents cost ~$0.004 (margin ~$0.016), Sonnet intents cost ~$0.012 (margin ~$0.008). Don't change pricing without recalculating.
- Cheerio page content truncated to 12k chars — prevents context window blowout on Claude calls
- User-Agent header identifies the bot — be a good citizen

## Phase 2: /valuate endpoint

Product valuation API at $0.05/call. Takes a product description, returns resale estimates. This connects to the home inventory app (separate project). Architecture TBD but likely:
- Input: { product: string, condition: string, photos?: string[] }
- Output: { estimated_value: { low, mid, high }, channels: [...], comparables: [...] }
- Data sources: eBay sold listings (scrape), Facebook Marketplace signals, depreciation models

## Phase 3: Vietnam market intelligence

Endpoints for Vietnamese business data once Michael is on the ground. TBD.
